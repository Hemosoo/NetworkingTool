/*
 * PennReach Penn Directory lookup bookmarklet.
 *
 * 1. Run `python3 -m pennreach lookup-list` (copies your pending names to the clipboard).
 * 2. Log in to the Penn Directory (https://directory.apps.upenn.edu/directory/jsp/fast.do,
 *    "Log in" with your PennKey) so student emails are visible.
 * 3. Click this bookmarklet and paste the list.
 * It runs one search per person, using your own logged-in session, with a short pause between
 * searches, then downloads penn_emails.csv for `python3 -m pennreach import-emails`.
 *
 * Build the bookmark with: python3 bookmarklet/build.py
 */
(function () {
  var MAX_PER_RUN = 40;

  if (!/directory\.apps\.upenn\.edu/.test(location.hostname)) {
    alert("PennReach: open the Penn Directory (directory.apps.upenn.edu) and log in first, then click this again.");
    return;
  }
  var raw = prompt("PennReach: paste the list from `python3 -m pennreach lookup-list`:", "");
  if (!raw) { return; }
  var people;
  try { people = JSON.parse(raw); } catch (e) { alert("PennReach: that doesn't look like the lookup list. Copy it again and retry."); return; }
  if (!people.length) { alert("PennReach: the list is empty."); return; }
  if (people.length > MAX_PER_RUN) {
    alert("PennReach: looking up the first " + MAX_PER_RUN + " of " + people.length + ". Run it again for the rest.");
    people = people.slice(0, MAX_PER_RUN);
  }

  var box = document.createElement("div");
  box.style.cssText = "position:fixed;top:12px;right:12px;z-index:99999;background:#011F5B;color:#fff;" +
    "font:14px/1.4 -apple-system,Helvetica,sans-serif;padding:12px 16px;border-radius:8px;max-width:340px;" +
    "box-shadow:0 4px 16px rgba(0,0,0,.3)";
  document.body.appendChild(box);
  function status(msg) { box.textContent = "PennReach: " + msg; }

  var parser = new DOMParser();
  function parse(text) { return parser.parseFromString(text, "text/html"); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clean(s) { return (s || "").replace(/ /g, " ").replace(/\s+/g, " ").trim(); }
  function buttonId(el) {
    var m = (el && el.getAttribute("onclick") || "").match(/fastButtonId=(\w+)|fastSubmitForm\(event,\s*'(\w+)'/);
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

  var base = new URL("fast.do", location.href).href;
  var current = document;

  // Get to a page that has the person search form (from results pages, follow "Search"/"Search Again").
  async function searchFormPage(doc) {
    if (doc.querySelector("form#searchPerson input[name=lastName]")) { return doc; }
    var links = doc.querySelectorAll("a[onclick]");
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      var label = clean(a.textContent) + " " + (a.getAttribute("title") || "") + " " + ((a.querySelector("img") || {}).alt || "");
      if (/search again|search the penn directory|^\s*search\s*$/i.test(label)) {
        var id = buttonId(a);
        if (id) {
          var next = parse(await getText(base + "?fastButtonId=" + id));
          if (next.querySelector("form#searchPerson input[name=lastName]")) { return next; }
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
    if (!form) { throw new Error("couldn't find the search form"); }
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
    var result = parse(await getText(new URL(form.getAttribute("action") || "fast.do", base).href, params.toString()));
    current = result;

    var rows = [];
    result.querySelectorAll("tr.lookupbody").forEach(function (tr) {
      var cells = tr.children;
      if (cells.length < 3) { return; }
      var contactCell = cells[2];
      var emails = [];
      var hay = contactCell.textContent + " " + Array.prototype.map.call(
        contactCell.querySelectorAll("a[href^='mailto:']"), function (a) { return a.getAttribute("href"); }).join(" ");
      (hay.match(/[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*upenn\.edu/gi) || []).forEach(function (e) {
        e = e.toLowerCase();
        if (emails.indexOf(e) < 0) { emails.push(e); }
      });
      rows.push({
        name: clean(cells[0].textContent),
        affiliation: clean(cells[1].textContent),
        email: emails.join(" "),
      });
    });
    return rows;
  }

  function csvCell(s) {
    s = String(s == null ? "" : s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  (async function () {
    var out = [["contact_id", "contact_name", "directory_name", "affiliation", "email"]];
    var found = 0;
    var anyEmail = false;
    for (var i = 0; i < people.length; i++) {
      var id = people[i][0], first = people[i][1], last = people[i][2];
      status("looking up " + (i + 1) + "/" + people.length + ": " + first + " " + last + "…");
      try {
        var rows = await search(first, last);
        if (!rows.length) { rows = await search("", last); }
        rows.forEach(function (r) {
          if (r.email) { anyEmail = true; }
          out.push([id, first + " " + last, r.name, r.affiliation, r.email]);
        });
        if (rows.length) { found++; }
      } catch (err) {
        out.push([id, first + " " + last, "", "error: " + err.message, ""]);
      }
      if (i < people.length - 1) { await sleep(2500 + Math.random() * 2500); }
    }
    var csv = out.map(function (r) { return r.map(csvCell).join(","); }).join("\n");
    var link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = "penn_emails.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();
    status("done: found listings for " + found + "/" + people.length + ". Downloaded penn_emails.csv." +
      (anyEmail ? "" : " No emails were visible. Are you logged in with your PennKey?"));
    setTimeout(function () { box.remove(); }, 15000);
  })();
})();
