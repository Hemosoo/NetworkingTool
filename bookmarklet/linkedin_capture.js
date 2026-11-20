/*
 * PennReach LinkedIn capture bookmarklet (best-effort).
 *
 * Run it on a LinkedIn people-search results page you are viewing yourself, e.g. a search for
 *   "incoming" with School = University of Pennsylvania.
 * Each click adds the people visible on the current page to a running list (stored in this
 * browser only). When you're done paging, choose OK to download contacts.csv for
 * `pennreach import contacts.csv`.
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

  for (var i = 0; i < anchors.length; i++) {
    var a = anchors[i];
    var url = profileUrl(a.getAttribute("href"));
    if (!url || data[url]) { continue; }
    var nameEl = a.querySelector('span[aria-hidden="true"]');
    var name = clean(nameEl ? nameEl.textContent : a.textContent);
    if (!name || JUNK.test(name) || name.length > 80) { continue; }

    var card = a.closest("li") || a.closest('[data-chameleon-result-urn]') || a.parentElement;
    var lines = (card ? card.innerText : "").split("\n").map(clean).filter(function (l) {
      return l && l !== name && !JUNK.test(l) && l.indexOf(name) !== 0;
    });
    var headline = lines[0] || "";
    var location = lines[1] || "";
    for (var j = 0; j < lines.length; j++) {
      if (/^(current|past):/i.test(lines[j])) { headline += " | " + lines[j]; break; }
    }
    data[url] = { name: name, headline: headline, location: location, linkedin_url: url };
  }

  save(data);
  var total = Object.keys(data).length;
  var added = total - before;
  var go = confirm(
    "PennReach: captured " + added + " new (" + total + " total).\n\n" +
    "OK = download contacts.csv now\nCancel = keep browsing (go to the next page and click again)"
  );
  if (!go) { return; }

  var rows = [["name", "headline", "location", "linkedin_url"]];
  Object.keys(data).forEach(function (k) {
    var p = data[k];
    rows.push([p.name, p.headline, p.location, p.linkedin_url]);
  });
  var csv = rows.map(function (r) { return r.map(csvCell).join(","); }).join("\n");
  var blob = new Blob([csv], { type: "text/csv" });
  var link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "contacts.csv";
  document.body.appendChild(link);
  link.click();
  link.remove();
  if (confirm("Downloaded. Clear the captured list?")) { save({}); }
})();
