/*
 * PennReach LinkedIn capture bookmarklet (best-effort).
 *
 * Run it on a LinkedIn people-search results page you are viewing yourself, e.g. a search for
 *   "incoming" with School = University of Pennsylvania.
 * Each click adds (or fills in missing headlines for) the people visible on the current page to a running list (stored in this
 * browser only). When you're done paging, type d to download contacts.csv for
 * `pennreach import contacts.csv`, or c to clear the list and start over.
 *
 * It reads only what's already on your screen; it doesn't crawl, click, or fetch anything.
 * LinkedIn changes its markup often, so if it captures 0 people the selectors need updating.
 *
 * Build the bookmark with: python3 bookmarklet/build.py
 */
(function () {
  var KEY = "pennreach_capture_v1";
  var JUNK = /^(view .*profile|connect|message|follow|pending|•|·|\d+(st|nd|rd|th)\+?$|\d+(st|nd|rd|th) degree connection|.*mutual connection|status is |provides services|see all|premium|open to work)/i;

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || "{}"); } catch (e) { return {}; }
  }
  function save(data) {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
  }
  function clean(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }
  function profileUrl(href) {
    var m = (href || "").match(/linkedin\.com\/in\/[^/?#]+|^\/in\/[^/?#]+/);
    if (!m) { return null; }
    var path = m[0].replace(/^.*?(\/in\/)/, "/in/");
    return "https://www.linkedin.com" + path;
  }
  function csvCell(s) {
    s = String(s == null ? "" : s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  var data = load();
  var before = Object.keys(data).length;
  var anchors = document.querySelectorAll('a[href*="/in/"]');

  // Links that show a person's name (photo links and buttons have no usable text).
  var candidates = [];
  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    var url = profileUrl(a.getAttribute("href"));
    if (!url) { continue; }
    var nameEl = a.querySelector('span[aria-hidden="true"]');
    var name = clean(nameEl ? nameEl.textContent : a.textContent);
    if (!name || JUNK.test(name) || name.length > 80) { continue; }
    candidates.push({ a: a, url: url, name: name });
  }

  // The results list = the element with the most child branches containing a name link.
  // Each of those children is one result card. This ignores page layout/class names entirely.
  var branchCounts = new Map();
  candidates.forEach(function (c) {
    var child = c.a;
    var parent = child.parentElement;
    while (parent && parent !== document.documentElement) {
      if (!branchCounts.has(parent)) { branchCounts.set(parent, new Set()); }
      branchCounts.get(parent).add(child);
      child = parent;
      parent = parent.parentElement;
    }
  });
  var list = null;
  var best = 0;
  branchCounts.forEach(function (children, el) {
    if (children.size > best) { best = children.size; list = el; }
  });

  // In each card, the first name link is the person; later ones (mutual connections) are ignored.
  var cards = [];
  if (list) {
    branchCounts.get(list).forEach(function (card) {
      for (var k = 0; k < candidates.length; k++) {
        if (card.contains(candidates[k].a)) { cards.push({ card: card, person: candidates[k] }); break; }
      }
    });
  }

  var updated = 0;
  cards.forEach(function (entry) {
    var person = entry.person;
    var url = person.url;
    if (data[url] && data[url].headline) { return; }
    var lines = (entry.card.innerText || "").split("\n").map(clean).filter(function (l) {
      return l && l !== person.name && !JUNK.test(l) && l.indexOf(person.name) !== 0;
    });
    var headline = lines[0] || "";
    var location = lines[1] || "";
    for (var j = 0; j < lines.length; j++) {
      if (/^(current|past):/i.test(lines[j])) { headline += " | " + lines[j]; break; }
    }
    if (data[url]) { updated++; }
    data[url] = { name: person.name, headline: headline, location: location, linkedin_url: url };
  });

  save(data);
  var total = Object.keys(data).length;
  var added = total - before;
  var missing = 0;
  Object.keys(data).forEach(function (k) { if (!data[k].headline) { missing++; } });
  var choice = prompt(
    "PennReach: captured " + added + " new" + (updated ? ", filled in " + updated : "") +
    " (" + total + " total" + (missing ? ", " + missing + " still missing a headline" : "") + ").\n\n" +
    "Type  d  to download contacts.csv\n" +
    "Type  c  to clear the captured list and start over\n" +
    "Or press Cancel to keep browsing (go to the next page and click again).",
    ""
  );
  choice = (choice || "").trim().toLowerCase();

  if (choice.charAt(0) === "c") {
    if (confirm("Clear all " + total + " captured people from this browser?")) {
      save({});
      alert("PennReach: cleared. Go to page 1 of your search and click again.");
    }
    return;
  }
  if (choice.charAt(0) !== "d") { return; }

  // People without a headline can't be filtered by firm/role, so leave them out of the file.
  var rows = [["name", "headline", "location", "linkedin_url"]];
  Object.keys(data).forEach(function (k) {
    var p = data[k];
    if (p.headline) { rows.push([p.name, p.headline, p.location, p.linkedin_url]); }
  });
  var csv = rows.map(function (r) { return r.map(csvCell).join(","); }).join("\n");
  var blob = new Blob([csv], { type: "text/csv" });
  var link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "contacts.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (confirm(
    "Downloaded " + (rows.length - 1) + " people" +
    (missing ? " (left out " + missing + " with no headline; revisit their pages to fill them in)" : "") +
    ".\n\nClear the captured list now? (OK = clear, Cancel = keep it)"
  )) { save({}); }
})();
