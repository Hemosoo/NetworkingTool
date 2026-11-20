/*
 * PennReach Penn Directory lookup (content script on directory.apps.upenn.edu).
 * When the side panel asks, it runs one directory search per person, inside your own
 * logged-in session, with a short pause between searches, and saves what it finds.
 * Student emails are only shown to logged-in users, so it stops early if you're logged out.
 */
(function () {
  "use strict";
  var Core = self.PennReachCore;
  var Store = self.PennReachStore;
  var running = false;

  var parser = new DOMParser();
  function parse(text) { return parser.parseFromString(text, "text/html"); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clean(s) { return Core.squash(s); }
  function buttonId(el) {
    var m = ((el && el.getAttribute("onclick")) || "").match(/fastButtonId=(\w+)|fastSubmitForm\(event,\s*'(\w+)'/);
    return m ? (m[1] || m[2]) : null;
  }
  function getText(url, body) {
    var opts = { credentials: "same-origin" };
    if (body) {
      opts.method = "POST";
      opts.headers = { "Content-Type": "application/x-www-form-urlencoded" };
      opts.body = body;
    }
    return fetch(url, opts).then(function (r) {
      if (!r.ok) { throw new Error("HTTP " + r.status); }
      return r.text();
    });
  }

  var base = new URL("/directory/jsp/fast.do", location.origin).href;
  var current = document;

  function hasForm(doc) { return !!doc.querySelector("form#searchPerson input[name=lastName]"); }

  // Get a page with the person search form (from results pages, follow "Search"/"Search Again").
  async function searchFormPage(doc) {
    if (hasForm(doc)) { return doc; }
    var links = doc.querySelectorAll("a[onclick]");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var label = clean(a.textContent) + " " + (a.getAttribute("title") || "") + " " +
        ((a.querySelector("img") || {}).alt || "");
      if (/search again|search the penn directory|^\s*search\s*$/i.test(label)) {
        var id = buttonId(a);
        if (id) {
          var next = parse(await getText(base + "?fastButtonId=" + id));
          if (hasForm(next)) { return next; }
        }
      }
    }
    return parse(await getText(base));
  }

  function rowText(input) {
    var tr = input.closest("tr");
    return tr ? clean(tr.textContent) : "";
  }

  async function search(first, last) {
    var doc = await searchFormPage(current);
    var form = doc.querySelector("form#searchPerson");
    if (!form) { throw new Error("couldn't find the directory search form"); }
    var params = new URLSearchParams();
    var lastInput = form.querySelector("input[name=lastName]");
    var firstInput = null;
    var affSelect = null;
    form.querySelectorAll("input[type=text]").forEach(function (inp) {
      if (!firstInput && inp !== lastInput && /first name/i.test(rowText(inp))) { firstInput = inp; }
    });
    form.querySelectorAll("select").forEach(function (sel) {
      if (sel.querySelector('option[value="STU"]')) { affSelect = sel; }
    });
    form.querySelectorAll("input, select").forEach(function (el) {
      if (!el.name || el.type === "image" || el.type === "submit") { return; }
      params.set(el.name, el.value || "");
    });
    params.set(lastInput.name, last);
    if (firstInput) { params.set(firstInput.name, first); }
    if (affSelect) { params.set(affSelect.name, "STU"); }
    var submit = null;
    doc.querySelectorAll("a.submitButton, a[onclick*='fastSubmitForm']").forEach(function (a) {
      if (!submit && /^search$/i.test(clean(a.textContent))) { submit = a; }
    });
    params.set("fastButtonId", buttonId(submit) || "");
    var action = new URL(form.getAttribute("action") || "fast.do", base).href;
    var result = parse(await getText(action, params.toString()));
    current = result;

    var rows = [];
    var loginWall = false;
    result.querySelectorAll("tr.lookupbody").forEach(function (tr) {
      var cells = tr.children;
      if (cells.length < 3) { return; }
      var contact = cells[2];
      if (/\[login\]/i.test(contact.textContent)) { loginWall = true; }
      var hay = contact.textContent + " " + Array.prototype.map.call(
        contact.querySelectorAll("a[href^='mailto:']"), function (a) { return a.getAttribute("href"); }).join(" ");
      var emails = [];
      (hay.match(/[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*upenn\.edu/gi) || []).forEach(function (e) {
        e = e.toLowerCase();
        if (emails.indexOf(e) < 0) { emails.push(e); }
      });
      rows.push({ name: clean(cells[0].textContent), affiliation: clean(cells[1].textContent), email: emails.join(" ") });
    });
    return { rows: rows, loginWall: loginWall };
  }

  function report(msg) {
    try { chrome.runtime.sendMessage(msg).catch(function () {}); } catch (e) { /* side panel closed */ }
  }

  async function lookupAll(people) {
    var found = 0;
    var picks = 0;
    var none = 0;
    for (var i = 0; i < people.length; i++) {
      var p = people[i];
      report({ type: "lookupProgress", done: i, total: people.length, name: p.first + " " + p.last });
      var res;
      try {
        res = await search(p.first, p.last);
        if (!res.rows.length) { res = await search("", p.last); }
      } catch (err) {
        report({ type: "lookupDone", error: String(err.message || err), found: found, picks: picks, none: none });
        return;
      }
      if (res.loginWall && !res.rows.some(function (r) { return r.email; })) {
        report({ type: "lookupDone", notLoggedIn: true, found: found, picks: picks, none: none });
        return;
      }
      var pick = Core.pickEmail(p.name, res.rows);
      if (pick.email) {
        var blocked = await Store.emailBlocked(pick.email, p.url);
        if (blocked) {
          await Store.updatePerson(p.url, { status: "do_not_contact", email: pick.email, note: blocked });
        } else {
          await Store.updatePerson(p.url, { status: "ready", email: pick.email, directoryName: pick.match.name });
          found++;
        }
      } else if (pick.candidates) {
        await Store.updatePerson(p.url, { status: "pick", candidates: pick.candidates });
        picks++;
      } else {
        await Store.updatePerson(p.url, { status: "no_email", lookedUpAt: Date.now() });
        none++;
      }
      if (i < people.length - 1) { await sleep(2500 + Math.random() * 2500); }
    }
    report({ type: "lookupDone", found: found, picks: picks, none: none, total: people.length });
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== "lookup") { return false; }
    if (running) { sendResponse({ busy: true }); return false; }
    running = true;
    sendResponse({ started: true });
    lookupAll(msg.people || []).finally(function () { running = false; });
    return false;
  });
})();
