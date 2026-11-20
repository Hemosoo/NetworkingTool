/* PennReach side panel. */
(function () {
  "use strict";
  var Core = self.PennReachCore;
  var Store = self.PennReachStore;

  var DIRECTORY_URL = "https://directory.apps.upenn.edu/directory/jsp/fast.do";
  var LINKEDIN_SEARCH_URL = "https://www.linkedin.com/search/results/people/?keywords=" +
    encodeURIComponent('incoming "University of Pennsylvania"');
  var SCHOOLS = ["the College", "Wharton", "SEAS", "Nursing", "M&T", "Huntsman", "Vagelos LSM"];
  var FOLLOWUP_AFTER_DAYS = 5;

  var state = {
    tab: "people",
    settings: null,
    people: [],
    showFiltered: false,
    editing: {},      // url -> {subject, body}
    pasted: {},       // url -> typed email
    lookup: { running: false, done: 0, total: 0, name: "", message: "", kind: "", lastTick: 0 },
  };

  // ---- Tiny DOM helper (always textContent, never innerHTML, for anything from LinkedIn) ----
  function el(tag, attrs) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v == null || v === false) { return; }
      if (k === "class") { node.className = v; }
      else if (k === "text") { node.textContent = v; }
      else if (k.slice(0, 2) === "on") { node.addEventListener(k.slice(2), v); }
      else if (k === "value") { node.value = v; }
      else if (v === true) { node.setAttribute(k, ""); }
      else { node.setAttribute(k, v); }
    });
    for (var i = 2; i < arguments.length; i++) { append(node, arguments[i]); }
    return node;
  }
  function append(node) {
    for (var i = 1; i < arguments.length; i++) {
      var child = arguments[i];
      if (child == null || child === false) { continue; }
      if (Array.isArray(child)) { child.forEach(function (c) { append(node, c); }); continue; }
      node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
    }
  }

  // ---- Data -----------------------------------------------------------------------------------

  function annotate(p) {
    var ev = Core.evaluate(p, state.settings);
    return Object.assign({}, p, { ev: ev, kept: (ev.keep || !!p.forceKeep) && p.status !== "removed" });
  }

  function groups() {
    var all = state.people.map(annotate);
    var kept = all.filter(function (p) { return p.kept; });
    function st() {
      var list = Array.prototype.slice.call(arguments);
      return kept.filter(function (p) { return list.indexOf(p.status) >= 0; });
    }
    return {
      all: all,
      kept: kept,
      filtered: all.filter(function (p) { return !p.kept && p.status !== "removed"; }),
      needEmail: st("new"),
      pick: st("pick"),
      noEmail: st("no_email"),
      found: kept.filter(function (p) { return p.email && p.status !== "do_not_contact"; }),
      toSend: st("ready", "opened"),
      skipped: st("skipped"),
      sent: all.filter(function (p) { return p.status === "sent"; }),
      sentToday: Core.sentInLast24h(all),
    };
  }

  async function reload() {
    state.settings = await Store.getSettings();
    state.people = await Store.allPeople();
  }

  function update(url, fields) { return Store.updatePerson(url, fields); }

  // ---- Rendering ------------------------------------------------------------------------------

  var flashTimer = null;
  function flash(msg, kind) {
    var f = document.getElementById("flash");
    f.textContent = msg;
    f.className = "flash" + (kind ? " " + kind : "");
    f.hidden = false;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { f.hidden = true; }, kind === "bad" || kind === "warn" ? 9000 : 4000);
  }

  function isTyping() {
    var a = document.activeElement;
    return a && (a.tagName === "INPUT" || a.tagName === "TEXTAREA" || a.tagName === "SELECT") &&
      document.getElementById("view").contains(a);
  }

  var pendingRender = false;
  function requestRender() {
    if (isTyping() || state.tab === "settings") { pendingRender = true; return; }
    render();
  }
  document.addEventListener("focusout", function () {
    setTimeout(function () {
      if (pendingRender && !isTyping() && state.tab !== "settings") { pendingRender = false; render(); }
    }, 0);
  });

  function render() {
    var g = groups();
    var s = state.settings;
    document.getElementById("stats").textContent =
      g.kept.length + (g.kept.length === 1 ? " person · " : " people · ") +
      g.found.length + (g.found.length === 1 ? " email · " : " emails · ") + g.sentToday + "/" + s.maxPerDay + " sent today";
    document.querySelectorAll("#tabs button").forEach(function (b) {
      var t = b.getAttribute("data-tab");
      b.setAttribute("aria-selected", String(t === state.tab));
      var old = b.querySelector(".badge");
      if (old) { old.remove(); }
      var n = t === "emails" ? g.needEmail.length + g.pick.length : t === "send" ? g.toSend.length : 0;
      if (n) { b.appendChild(el("span", { class: "badge", text: String(n) })); }
    });
    document.getElementById("settings-btn").classList.toggle("active", state.tab === "settings");
    var view = document.getElementById("view");
    view.textContent = "";
    var builders = { people: viewPeople, emails: viewEmails, send: viewSend, tracker: viewTracker, settings: viewSettings };
    append(view, builders[state.tab](g));
  }

  function go(tab) {
    state.tab = tab;
    pendingRender = false;
    render();
    window.scrollTo(0, 0);
  }

  function initials(name) {
    var parts = Core.cleanName(name).split(" ").filter(Boolean);
    return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }

  function statusChip(p) {
    var map = {
      new: ["Needs email", ""], pick: ["Choose match", "warn"], no_email: ["No email found", "warn"],
      ready: ["Ready to send", "ok"], opened: ["Opened in Gmail", "warn"], sent: ["Sent", "ok"],
      skipped: ["Skipped", ""], do_not_contact: ["Do not contact", "bad"],
    };
    var m = map[p.status] || [p.status, ""];
    return el("span", { class: "chip " + m[1], text: m[0] });
  }

  function personRow(p, extra) {
    var chips = [];
    if (p.ev.firm) { chips.push(el("span", { class: "chip firm", text: p.ev.firm })); }
    if (p.ev.classYear) { chips.push(el("span", { class: "chip", text: "'" + String(p.ev.classYear).slice(-2) })); }
    if (p.kept) { chips.push(statusChip(p)); }
    else { chips.push(el("span", { class: "chip", text: p.ev.reason })); }
    return el("div", { class: "person" },
      el("div", { class: "avatar", text: initials(p.name) }),
      el("div", { class: "main" },
        p.linkedin_url.indexOf("https://") === 0
          ? el("a", { class: "name", href: p.linkedin_url, target: "_blank", rel: "noopener", text: p.name })
          : el("span", { class: "name", text: p.name }),
        el("div", { class: "headline", text: p.headline || "No headline" }),
        el("div", { class: "chips" }, chips)),
      extra ? el("div", { class: "actions" }, extra) : null);
  }

  function emptyState(icon, title, sub) {
    return el("div", { class: "empty" }, el("div", { class: "big", text: icon }), el("b", { text: title }),
      sub ? el("div", { class: "note", text: sub }) : null);
  }

  // ---- 1. People --------------------------------------------------------------------------------

  function viewPeople(g) {
    var s = state.settings;
    var out = [];
    out.push(el("div", { class: "card hero" },
      el("h2", { text: "Collect people from LinkedIn" }),
      el("p", { text: "Search LinkedIn and click through the result pages. Everyone on your screen is saved here automatically, and only matches are kept." }),
      el("div", { class: "row" },
        el("button", { class: "btn primary", onclick: function () { chrome.tabs.create({ url: LINKEDIN_SEARCH_URL }); } },
          "Open LinkedIn search"),
        el("button", { class: "btn", onclick: captureNow }, "Capture this page")),
      el("div", { class: "note", text: "Tip: add LinkedIn's School filter → University of Pennsylvania for better results." }),
      el("div", { class: "toggle" },
        el("div", {}, el("div", { class: "label", text: "Auto-collect" }),
          el("div", { class: "sub", text: s.collecting ? "On: saving people as you browse searches" : "Paused" })),
        el("label", { class: "switch" },
          el("input", { type: "checkbox", checked: s.collecting, onchange: async function (e) {
            s.collecting = e.target.checked;
            await Store.saveSettings(s);
          } }),
          el("span")))));

    out.push(el("div", { class: "section-title" }, el("span", { text: "Matches (" + g.kept.length + ")" })));
    var listCard = el("div", { class: "card" });
    if (!g.kept.length) {
      append(listCard, emptyState("🔎", "No matches yet", "Open a LinkedIn people search to get started."));
    } else {
      var list = el("div", { class: "list" });
      g.kept.slice().reverse().forEach(function (p) {
        append(list, personRow(p, el("button", { class: "btn ghost small", title: "Remove", "aria-label": "Remove " + p.name,
          onclick: function () { update(p.linkedin_url, { status: "removed" }); } }, "✕")));
      });
      append(listCard, list);
    }
    out.push(listCard);

    if (g.filtered.length) {
      var det = el("details", { open: state.showFiltered, ontoggle: function (e) { state.showFiltered = e.target.open; } },
        el("summary", { text: "Filtered out (" + g.filtered.length + "): not incoming, not a target firm, etc." }));
      var fl = el("div", { class: "card list" });
      g.filtered.slice().reverse().forEach(function (p) {
        append(fl, personRow(p, el("button", { class: "btn small", onclick: function () {
          update(p.linkedin_url, { forceKeep: true });
        } }, "Keep")));
      });
      append(det, fl);
      out.push(det);
    }

    if (g.needEmail.length) {
      out.push(el("button", { class: "btn primary big", onclick: function () { go("emails"); } },
        "Next: find " + g.needEmail.length + " Penn email" + (g.needEmail.length === 1 ? "" : "s") + " →"));
    }
    return out;
  }

  async function captureNow() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    if (!tab || !/^https:\/\/www\.linkedin\.com\/search\/results\//.test(tab.url || "")) {
      flash("Open a LinkedIn people search in this window first.", "warn");
      return;
    }
    try {
      var res = await chrome.tabs.sendMessage(tab.id, { type: "capture" });
      if (res && res.found === 0) { flash("No people found on this page. Scroll down so the results load, then try again.", "warn"); }
      else if (res) { flash("Saved " + res.added + " new" + (res.updated ? ", updated " + res.updated : "") + " from this page."); }
    } catch (e) {
      await chrome.tabs.reload(tab.id);
      flash("Refreshed the LinkedIn tab so PennReach can read it. Click Capture again in a moment.", "warn");
    }
  }

  // ---- 2. Emails --------------------------------------------------------------------------------

  function viewEmails(g) {
    var out = [];
    var L = state.lookup;
    var hero = el("div", { class: "card hero" },
      el("h2", { text: "Find Penn emails" }),
      el("p", { text: "PennReach looks each person up in the Penn Directory for you. Student emails only show when you're logged in, so sign in with your PennKey the first time." }));
    if (L.running) {
      var pct = L.total ? Math.round((L.done / L.total) * 100) : 0;
      append(hero, el("div", { class: "progress" }, el("div", { style: "width:" + pct + "%" })));
      append(hero, el("div", { class: "note", text: "Looking up " + Math.min(L.done + 1, L.total) + " of " + L.total + (L.name ? ": " + L.name : "") + "…" }));
    } else {
      append(hero, el("button", { class: "btn primary big", disabled: !g.needEmail.length, onclick: findEmails },
        g.needEmail.length ? "Find emails for " + g.needEmail.length + " " + (g.needEmail.length === 1 ? "person" : "people") : "Everyone has been looked up"));
      append(hero, el("div", { class: "row", style: "margin-top:8px" },
        el("button", { class: "linkish", onclick: function () { openDirectory(true); } }, "Open the Penn Directory")));
    }
    if (L.message) {
      append(hero, el("div", { class: "flash " + (L.kind || ""), style: "margin:10px 0 0", text: L.message }));
    }
    out.push(hero);

    if (g.pick.length) {
      out.push(el("div", { class: "section-title" }, el("span", { text: "Choose the right person (" + g.pick.length + ")" })));
      g.pick.forEach(function (p) {
        var card = el("div", { class: "card" }, personRow(p));
        (p.candidates || []).forEach(function (c) {
          append(card, el("div", { class: "candidate" },
            el("div", { class: "who" }, el("b", { text: c.name }), el("span", { text: c.affiliation + " · " + c.email })),
            el("button", { class: "btn small primary", onclick: function () { setEmail(p, c.email); } }, "Use")));
        });
        append(card, el("div", { class: "row", style: "margin-top:8px" },
          el("button", { class: "btn small ghost", onclick: function () { update(p.linkedin_url, { status: "no_email", candidates: null }); } },
            "None of these")));
        out.push(card);
      });
    }

    if (g.noEmail.length) {
      out.push(el("div", { class: "section-title" }, el("span", { text: "Couldn't find automatically (" + g.noEmail.length + ")" })));
      g.noEmail.forEach(function (p) {
        var input = el("input", { type: "email", placeholder: "Paste their @upenn.edu email", value: state.pasted[p.linkedin_url] || "",
          oninput: function (e) { state.pasted[p.linkedin_url] = e.target.value; },
          onkeydown: function (e) { if (e.key === "Enter") { saveTyped(p); } } });
        out.push(el("div", { class: "card" }, personRow(p),
          el("div", { class: "row", style: "margin-top:8px" }, input),
          el("div", { class: "row", style: "margin-top:8px" },
            el("button", { class: "btn small primary", onclick: function () { saveTyped(p); } }, "Save"),
            el("button", { class: "btn small", onclick: function () { openDirectory(true); } }, "Search directory"),
            el("button", { class: "btn small ghost", onclick: function () { update(p.linkedin_url, { status: "skipped" }); } }, "Skip"))));
      });
    }

    var found = g.kept.filter(function (p) { return p.email && (p.status === "ready" || p.status === "opened"); });
    if (found.length) {
      out.push(el("div", { class: "section-title" }, el("span", { text: "Found (" + found.length + ")" })));
      var fc = el("div", { class: "card list" });
      found.forEach(function (p) {
        append(fc, el("div", { class: "person" },
          el("div", { class: "avatar", text: initials(p.name) }),
          el("div", { class: "main" }, el("div", { class: "name", text: p.name }), el("div", { class: "headline", text: p.email }))));
      });
      out.push(fc);
      out.push(el("button", { class: "btn primary big", onclick: function () { go("send"); } }, "Next: review & send →"));
    }
    if (!g.needEmail.length && !g.pick.length && !g.noEmail.length && !found.length) {
      out.push(el("div", { class: "card" }, emptyState("📭", "Nobody to look up yet", "Collect some people in step 1 first.")));
    }
    return out;
  }

  async function setEmail(p, email) {
    email = Core.extractPennEmail(email);
    if (!email) { flash("That isn't a @upenn.edu address.", "bad"); return false; }
    var blocked = await Store.emailBlocked(email, p.linkedin_url);
    if (blocked) { flash(email + " is " + blocked + ".", "warn"); return false; }
    await update(p.linkedin_url, { email: email, status: "ready", candidates: null });
    delete state.pasted[p.linkedin_url];
    return true;
  }

  async function saveTyped(p) {
    var ok = await setEmail(p, state.pasted[p.linkedin_url] || "");
    if (ok) { flash("Saved " + p.name + "'s email."); }
  }

  async function findDirectoryTab() {
    var tabs = await chrome.tabs.query({ url: "https://directory.apps.upenn.edu/directory/*" });
    return tabs[0] || null;
  }

  async function openDirectory(focus) {
    var tab = await findDirectoryTab();
    if (tab) {
      if (focus) { await chrome.tabs.update(tab.id, { active: true }); }
      return tab;
    }
    return chrome.tabs.create({ url: DIRECTORY_URL, active: !!focus });
  }

  async function findEmails() {
    var g = groups();
    var queue = [];
    for (var i = 0; i < g.needEmail.length; i++) {
      var p = g.needEmail[i];
      var n = Core.searchName(p.name);
      if (n) { queue.push({ url: p.linkedin_url, name: p.name, first: n.first, last: n.last }); }
      else { await update(p.linkedin_url, { status: "no_email" }); } // e.g. "Jane D."
    }
    if (!queue.length) { render(); return; }
    var L = state.lookup;
    var tab = await findDirectoryTab();
    if (!tab) {
      await chrome.tabs.create({ url: DIRECTORY_URL, active: true });
      L.message = "Opened the Penn Directory. Click “Log in” at the top of that page and sign in with your PennKey, then come back and click Find emails again.";
      L.kind = "warn";
      render();
      return;
    }
    try {
      var res = await chrome.tabs.sendMessage(tab.id, { type: "lookup", people: queue });
      if (res && res.busy) { L.message = "A lookup is already running."; L.kind = "warn"; render(); return; }
      Object.assign(L, { running: true, done: 0, total: queue.length, name: queue[0].name, message: "", kind: "", lastTick: Date.now() });
      render();
    } catch (e) {
      await chrome.tabs.reload(tab.id);
      L.message = "Refreshed the directory tab so PennReach can use it. Make sure you're logged in, then click Find emails again.";
      L.kind = "warn";
      render();
    }
  }

  chrome.runtime.onMessage.addListener(async function (msg) {
    var L = state.lookup;
    if (!msg || !msg.type) { return; }
    if (msg.type === "lookupProgress") {
      Object.assign(L, { running: true, done: msg.done, total: msg.total, name: msg.name, lastTick: Date.now() });
      if (state.tab === "emails") { requestRender(); }
    } else if (msg.type === "lookupDone") {
      L.running = false;
      if (msg.notLoggedIn) {
        L.message = "You're not logged in to the Penn Directory, so emails are hidden. In the directory tab, click “Log in” at the top and sign in with your PennKey, then click Find emails again.";
        L.kind = "warn";
        var tab = await findDirectoryTab();
        if (tab) { chrome.tabs.update(tab.id, { active: true }); }
      } else if (msg.error) {
        L.message = "The lookup stopped: " + msg.error + ". Try again in a minute.";
        L.kind = "bad";
      } else {
        L.message = "Done: found " + msg.found + " email" + (msg.found === 1 ? "" : "s") +
          (msg.picks ? ", " + msg.picks + " need you to choose" : "") +
          (msg.none ? ", " + msg.none + " not found" : "") + ".";
        L.kind = "";
      }
      requestRender();
    }
  });

  // If the directory tab is closed mid-lookup we stop hearing from it.
  setInterval(function () {
    var L = state.lookup;
    if (L.running && Date.now() - L.lastTick > 45000) {
      L.running = false;
      L.message = "The lookup stopped responding (was the directory tab closed?). Click Find emails to continue.";
      L.kind = "warn";
      requestRender();
    }
  }, 5000);

  // ---- 3. Send ----------------------------------------------------------------------------------

  function viewSend(g) {
    var s = state.settings;
    var out = [];
    var left = Math.max(0, s.maxPerDay - g.sentToday);
    if (!s.me.pennEmail) {
      out.push(el("div", { class: "flash warn", style: "margin:0" },
        "Add your Penn email in ", el("button", { class: "linkish", onclick: function () { go("settings"); } }, "Settings"),
        " so Gmail opens in your Penn account."));
    }
    out.push(el("div", { class: "card hero" },
      el("h2", { text: left ? "You can send " + left + " more today" : "Daily limit reached" }),
      el("p", { text: left
        ? "Click Open in Gmail: the email opens ready to go. Read it, hit Send in Gmail, then confirm here."
        : "You've sent " + g.sentToday + " in the last 24 hours. Come back tomorrow; small batches get more replies." })));

    if (!g.toSend.length) {
      out.push(el("div", { class: "card" }, emptyState("✉️", "Nothing waiting to send",
        g.needEmail.length || g.pick.length ? "Finish finding emails in step 2." : "Collect people and find their emails first.")));
    }
    g.toSend.forEach(function (p) { out.push(emailCard(p, left)); });

    if (g.skipped.length) {
      var det = el("details", {}, el("summary", { text: "Skipped (" + g.skipped.length + ")" }));
      var sc = el("div", { class: "card list" });
      g.skipped.forEach(function (p) {
        append(sc, personRow(p, el("button", { class: "btn small", onclick: function () {
          update(p.linkedin_url, { status: p.email ? "ready" : "new" });
        } }, "Restore")));
      });
      append(det, sc);
      out.push(det);
    }
    return out;
  }

  function emailCard(p, left) {
    var draft = Core.draftFor(p, state.settings);
    var url = p.linkedin_url;
    var card = el("div", { class: "card" },
      el("div", { class: "email-head" },
        el("div", {}, el("div", { class: "name", style: "font-weight:600", text: p.name }),
          el("div", { class: "to", text: "To: " + p.email })),
        p.ev.firm ? el("span", { class: "chip firm", text: p.ev.firm }) : null));

    if (p.status === "opened") {
      append(card, el("div", { class: "confirm" },
        el("strong", { text: "Did you send it in Gmail?" }),
        el("div", { class: "row" },
          el("button", { class: "btn good", onclick: function () {
            update(url, { status: "sent", sentAt: Date.now() });
            flash("Nice! Marked " + p.name + " as sent.");
          } }, "Yes, sent ✓"),
          el("button", { class: "btn", onclick: function () { update(url, { status: "ready" }); } }, "Not yet"),
          el("button", { class: "btn ghost", onclick: function () { openGmail(p, draft); } }, "Reopen"))));
      return card;
    }

    var ed = state.editing[url];
    if (ed) {
      append(card,
        el("label", { class: "field" }, el("span", { text: "Subject" }),
          el("input", { type: "text", value: ed.subject, oninput: function (e) { ed.subject = e.target.value; } })),
        el("label", { class: "field" }, el("span", { text: "Message" }),
          el("textarea", { rows: "11", value: ed.body, oninput: function (e) { ed.body = e.target.value; } })),
        el("div", { class: "row" },
          el("button", { class: "btn primary", onclick: async function () {
            delete state.editing[url];
            await update(url, { subjectOverride: ed.subject, bodyOverride: ed.body });
          } }, "Save"),
          el("button", { class: "btn", onclick: function () { delete state.editing[url]; render(); } }, "Cancel"),
          el("button", { class: "btn ghost", onclick: async function () {
            delete state.editing[url];
            await update(url, { subjectOverride: null, bodyOverride: null });
          } }, "Reset to template")));
      return card;
    }

    append(card,
      el("div", { class: "subject", text: draft.subject }),
      el("div", { class: "body", text: draft.body }),
      el("div", { class: "row" },
        el("button", { class: "btn primary", disabled: !left, onclick: function () { openGmail(p, draft); } }, "Open in Gmail"),
        el("button", { class: "btn", onclick: function () {
          state.editing[url] = { subject: draft.subject, body: draft.body };
          render();
        } }, "Edit"),
        el("button", { class: "btn ghost", onclick: function () { update(url, { status: "skipped" }); } }, "Skip")));
    return card;
  }

  async function openGmail(p, draft) {
    var blocked = await Store.emailBlocked(p.email, p.linkedin_url);
    if (blocked) { flash(p.email + " is " + blocked + ".", "warn"); return; }
    if (Core.sentInLast24h(state.people) >= state.settings.maxPerDay) { flash("Daily limit reached. Try again tomorrow.", "warn"); return; }
    await update(p.linkedin_url, { status: "opened", openedAt: Date.now(), sentSubject: draft.subject });
    chrome.tabs.create({ url: Core.gmailComposeUrl(p.email, draft.subject, draft.body, state.settings.me.pennEmail) });
  }

  // ---- Tracker ----------------------------------------------------------------------------------

  function ago(ts) {
    var d = Math.floor((Date.now() - ts) / 86400000);
    if (d <= 0) { return "today"; }
    return d === 1 ? "yesterday" : d + " days ago";
  }

  function viewTracker(g) {
    var out = [];
    var replied = g.sent.filter(function (p) { return p.repliedAt; }).length;
    var booked = g.sent.filter(function (p) { return p.bookedAt; }).length;
    out.push(el("div", { class: "stat-row" },
      el("div", { class: "stat" }, el("b", { text: String(g.sent.length) }), el("span", { text: "Sent" })),
      el("div", { class: "stat" }, el("b", { text: String(replied) }), el("span", { text: "Replied" })),
      el("div", { class: "stat" }, el("b", { text: String(booked) }), el("span", { text: "Coffee chats" }))));

    var card = el("div", { class: "card" });
    if (!g.sent.length) {
      append(card, emptyState("☕", "No emails sent yet", "People you email show up here so you can track replies."));
    } else {
      var list = el("div", { class: "list" });
      g.sent.slice().sort(function (a, b) { return b.sentAt - a.sentAt; }).forEach(function (p) {
        var due = !p.repliedAt && !p.followedUpAt && Date.now() - p.sentAt > FOLLOWUP_AFTER_DAYS * 86400000;
        var chips = [el("span", { class: "chip", text: "Sent " + ago(p.sentAt) })];
        if (p.ev.firm) { chips.unshift(el("span", { class: "chip firm", text: p.ev.firm })); }
        if (p.repliedAt) { chips.push(el("span", { class: "chip ok", text: "Replied" })); }
        if (p.bookedAt) { chips.push(el("span", { class: "chip ok", text: "Coffee booked ☕" })); }
        if (p.followedUpAt) { chips.push(el("span", { class: "chip", text: "Followed up" })); }
        if (due) { chips.push(el("span", { class: "chip warn", text: "Follow-up due" })); }
        append(list, el("div", { class: "person" },
          el("div", { class: "avatar", text: initials(p.name) }),
          el("div", { class: "main" },
            el("a", { class: "name", href: p.linkedin_url.indexOf("https://") === 0 ? p.linkedin_url : null, target: "_blank", rel: "noopener", text: p.name }),
            el("div", { class: "headline", text: p.email }),
            el("div", { class: "chips" }, chips),
            el("div", { class: "row", style: "margin-top:6px" },
              !p.repliedAt ? el("button", { class: "btn small", onclick: function () { update(p.linkedin_url, { repliedAt: Date.now() }); } }, "They replied") : null,
              !p.bookedAt ? el("button", { class: "btn small", onclick: function () { update(p.linkedin_url, { bookedAt: Date.now(), repliedAt: p.repliedAt || Date.now() }); } }, "Coffee booked") : null,
              due ? el("button", { class: "btn small primary", onclick: function () { followUp(p); } }, "Follow up") : null,
              el("button", { class: "btn small ghost", onclick: function () {
                if (confirm("Never email " + p.name + " again?")) { update(p.linkedin_url, { status: "do_not_contact" }); }
              } }, "Don't contact")))));
      });
      append(card, list);
    }
    out.push(card);

    out.push(el("div", { class: "card" },
      el("h3", { text: "Your data" }),
      el("p", { text: "Everything stays in this browser. Export a backup, or import a CSV (e.g. from the older PennReach bookmarklet)." }),
      el("div", { class: "row" },
        el("button", { class: "btn", onclick: exportCsv }, "Export CSV"),
        el("button", { class: "btn", onclick: function () { document.getElementById("import-file").click(); } }, "Import CSV"))));
    return out;
  }

  function followUp(p) {
    var f = Core.followupFor(p, state.settings);
    update(p.linkedin_url, { followedUpAt: Date.now() });
    chrome.tabs.create({ url: Core.gmailComposeUrl(p.email, f.subject, f.body, state.settings.me.pennEmail) });
  }

  function exportCsv() {
    var csv = Core.toCsv(state.people, state.settings);
    var a = el("a", { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "pennreach-backup.csv" });
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  document.getElementById("import-file").addEventListener("change", async function (e) {
    var file = e.target.files[0];
    e.target.value = "";
    if (!file) { return; }
    var rows = Core.parseCsv(await file.text());
    var list = rows.map(function (r) {
      var url = Core.normalizeLinkedinUrl(r.linkedin_url || r.url || r.profile || "");
      var name = r.name || r.full_name || "";
      return {
        name: name,
        headline: r.headline || r.title || "",
        location: r.location || "",
        linkedin_url: url || (name ? "manual:" + name.toLowerCase() : ""),
        email: Core.extractPennEmail(r.email || ""),
      };
    });
    var res = await Store.addCaptured(list);
    flash("Imported " + res.added + " new" + (res.updated ? ", updated " + res.updated : "") + " from " + file.name + ".");
  });

  // ---- Settings ---------------------------------------------------------------------------------

  function viewSettings() {
    var s = JSON.parse(JSON.stringify(state.settings));
    var firstRun = !state.settings.me.name;
    function field(label, input, help) {
      return el("label", { class: "field" }, el("span", { text: label }), input, help ? el("div", { class: "help", text: help }) : null);
    }
    var f = {
      name: el("input", { type: "text", value: s.me.name, placeholder: "Alex Chen" }),
      school: el("select", {}, SCHOOLS.map(function (o) { return el("option", { value: o, selected: o === s.me.school, text: o }); })),
      major: el("input", { type: "text", value: s.me.major, placeholder: "Economics" }),
      year: el("input", { type: "number", value: s.me.year, min: "2025", max: "2040" }),
      interests: el("input", { type: "text", value: s.me.interests, placeholder: "finance and tech" }),
      pennEmail: el("input", { type: "email", value: s.me.pennEmail, placeholder: "you@sas.upenn.edu" }),
      gradYear: el("input", { type: "number", value: (s.targeting.gradYears || [])[0] || "", min: "2025", max: "2040" }),
      firms: el("textarea", { rows: "8", value: s.targeting.firms.join("\n") }),
      requireIncoming: el("input", { type: "checkbox", checked: s.targeting.requireIncoming }),
      excludeInterns: el("input", { type: "checkbox", checked: s.targeting.excludeInterns }),
      subject: el("input", { type: "text", value: s.template.subject }),
      body: el("textarea", { rows: "12", value: s.template.body }),
      maxPerDay: el("input", { type: "number", value: s.maxPerDay, min: "1", max: "50" }),
    };
    var placeholders = Object.keys(Core.templateFields({ name: "" }, { firm: "", role: "" }, s.me))
      .map(function (k) { return "{" + k + "}"; }).join(" ");

    async function save() {
      var next = {
        me: {
          name: f.name.value.trim(), school: f.school.value, major: f.major.value.trim(),
          year: parseInt(f.year.value, 10) || s.me.year, interests: f.interests.value.trim(),
          pennEmail: f.pennEmail.value.trim().toLowerCase(),
        },
        targeting: {
          gradYears: f.gradYear.value ? [parseInt(f.gradYear.value, 10)] : [],
          requireIncoming: f.requireIncoming.checked,
          excludeInterns: f.excludeInterns.checked,
          firms: f.firms.value.split("\n").map(function (x) { return x.trim(); }).filter(Boolean),
        },
        template: { subject: f.subject.value, body: f.body.value },
        maxPerDay: Math.max(1, parseInt(f.maxPerDay.value, 10) || 15),
        collecting: state.settings.collecting,
      };
      if (!next.me.name) { flash("Please enter your name.", "bad"); f.name.focus(); return; }
      if (next.me.pennEmail && !Core.isPennEmail(next.me.pennEmail)) { flash("Your email should end in upenn.edu.", "bad"); f.pennEmail.focus(); return; }
      var unknown = Core.unknownPlaceholders(next.template.subject + next.template.body,
        Core.templateFields({ name: "" }, { firm: "", role: "" }, next.me));
      if (unknown.length) { flash("Unknown placeholder in the template: {" + unknown.join("}, {") + "}", "bad"); return; }
      await Store.saveSettings(next);
      state.settings = next;
      flash("Settings saved.");
      go(firstRun ? "people" : state.prevTab || "people");
    }

    var out = [];
    if (firstRun) {
      out.push(el("div", { class: "card hero" },
        el("h2", { text: "Welcome to PennReach 👋" }),
        el("p", { text: "Fill this in once. It's used to write your emails. Everything stays in your browser." })));
    }
    out.push(el("div", { class: "card" }, el("h3", { text: "About you" }),
      field("Your name", f.name),
      el("div", { class: "grid2" }, field("School", f.school), field("Graduation year", f.year)),
      field("Major", f.major),
      field("Interests", f.interests, "Finishes the sentence “I'm really interested in …”"),
      field("Your Penn email", f.pennEmail, "So Gmail opens in your Penn account.")));
    out.push(el("div", { class: "card" }, el("h3", { text: "Who to look for" }),
      field("Seniors' graduation year", f.gradYear, "People whose headline shows a different class year are filtered out."),
      field("Target firms (one per line)", f.firms),
      el("label", { class: "check" }, f.requireIncoming, "Only people whose headline says Incoming / Returning"),
      el("label", { class: "check" }, f.excludeInterns, "Skip internships (usually underclassmen)")));
    out.push(el("div", { class: "card" }, el("h3", { text: "Your email" }),
      field("Subject", f.subject),
      field("Message", f.body),
      el("div", { class: "help" }, "Placeholders: ", el("code", { text: placeholders })),
      el("div", { class: "row" }, el("button", { class: "btn small ghost", onclick: function () {
        f.subject.value = Core.DEFAULT_TEMPLATE.subject;
        f.body.value = Core.DEFAULT_TEMPLATE.body;
      } }, "Reset to default template"))));
    out.push(el("div", { class: "card" }, el("h3", { text: "Limits" }),
      field("Max emails per day", f.maxPerDay, "Small batches get more replies and keep your account out of spam filters.")));
    out.push(el("button", { class: "btn primary big", onclick: save }, firstRun ? "Save & start" : "Save settings"));
    if (!firstRun) {
      out.push(el("button", { class: "btn ghost", onclick: function () { go(state.prevTab || "people"); } }, "Cancel"));
      out.push(el("div", { class: "card" }, el("h3", { text: "Danger zone" }),
        el("button", { class: "btn small", style: "color:var(--bad)", onclick: async function () {
          if (confirm("Delete all PennReach people, emails and settings from this browser?")) {
            await Store.clearAll();
            await reload();
            go("settings");
          }
        } }, "Delete all data")));
    }
    return out;
  }

  // ---- Wiring -----------------------------------------------------------------------------------

  document.getElementById("tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-tab]");
    if (b && state.settings.me.name) { go(b.getAttribute("data-tab")); }
    else if (b) { flash("Fill in your name first, then hit Save & start.", "warn"); }
  });
  document.getElementById("settings-btn").addEventListener("click", function () {
    if (state.tab === "settings") { go(state.prevTab || "people"); return; }
    state.prevTab = state.tab;
    go("settings");
  });

  var reloadTimer = null;
  chrome.storage.onChanged.addListener(function (changes, area) {
    if (area !== "local") { return; }
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(async function () { await reload(); requestRender(); }, 120);
  });

  (async function init() {
    await reload();
    if (!state.settings.me.name) { state.tab = "settings"; }
    render();
  })();
})();
