/*
 * PennReach LinkedIn collector (content script).
 * While you browse LinkedIn people-search results, it reads the result cards already on your
 * screen and saves them to the extension. It never clicks, scrolls, pages or fetches anything.
 */
(function () {
  "use strict";
  var Core = self.PennReachCore;
  var Store = self.PennReachStore;

  var JUNK = /^([^a-z0-9]*\d+(st|nd|rd|th)\+?(\s|$)|view .*profile|connect|message|follow|following|pending|•|·|\d+(st|nd|rd|th)\+?$|\d+(st|nd|rd|th) degree connection|.*mutual connections?|status is |provides services|see all|premium|open to work|verified|send inmail)/i;

  function onSearchPage() {
    return /^\/search\/results\//.test(location.pathname);
  }

  /** Read the people on the current results page. Layout-independent: no class names. */
  function extractPeople(doc) {
    var candidates = [];
    var anchors = doc.querySelectorAll('a[href*="/in/"]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      var url = Core.normalizeLinkedinUrl(a.getAttribute("href"));
      if (!url) { continue; }
      var nameEl = a.querySelector('span[aria-hidden="true"]');
      var name = Core.squash(nameEl ? nameEl.textContent : a.textContent);
      if (!name || JUNK.test(name) || name.length > 80) { continue; }
      candidates.push({ a: a, url: url, name: name });
    }
    // The results list = the element with the most child branches containing a name link;
    // each of those children is one result card.
    var branches = new Map();
    candidates.forEach(function (c) {
      var child = c.a;
      var parent = child.parentElement;
      while (parent && parent !== doc.documentElement) {
        if (!branches.has(parent)) { branches.set(parent, new Set()); }
        branches.get(parent).add(child);
        child = parent;
        parent = parent.parentElement;
      }
    });
    var list = null;
    var best = 1; // need at least 2 results to trust the structure
    branches.forEach(function (children, el) {
      if (children.size > best) { best = children.size; list = el; }
    });
    if (!list) { return []; }

    var people = [];
    var seen = {};
    branches.get(list).forEach(function (card) {
      var person = null;
      for (var k = 0; k < candidates.length; k++) {
        if (card.contains(candidates[k].a)) { person = candidates[k]; break; } // first link = the person
      }
      if (!person || seen[person.url]) { return; }
      seen[person.url] = true;
      var lines = (card.innerText || card.textContent || "").split("\n").map(Core.squash).filter(function (l) {
        return l && l !== person.name && !JUNK.test(l) && l.indexOf(person.name) !== 0;
      });
      var headline = lines[0] || "";
      for (var j = 0; j < lines.length; j++) {
        if (/^(current|past):/i.test(lines[j])) { headline += " | " + lines[j]; break; }
      }
      people.push({ name: person.name, headline: headline, location: lines[1] || "", linkedin_url: person.url });
    });
    return people;
  }

  var toastTimer = null;
  function toast(msg) {
    var el = document.getElementById("pennreach-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "pennreach-toast";
      el.style.cssText = "position:fixed;bottom:20px;left:20px;z-index:2147483647;background:#011F5B;color:#fff;" +
        "font:600 13px/1.3 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:10px 14px;border-radius:10px;" +
        "box-shadow:0 6px 20px rgba(0,0,0,.25);transition:opacity .3s;pointer-events:none";
      document.documentElement.appendChild(el);
    }
    el.textContent = msg;
    el.style.opacity = "1";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.opacity = "0"; }, 2500);
  }

  async function capture(manual) {
    if (!onSearchPage()) { return { added: 0, updated: 0, found: 0, notSearch: true }; }
    var settings = await Store.getSettings();
    if (!settings.collecting && !manual) { return { added: 0, updated: 0, found: 0, paused: true }; }
    var people = extractPeople(document);
    var res = await Store.addCaptured(people);
    res.found = people.length;
    if (res.added || res.updated) {
      toast("PennReach: +" + res.added + " people" + (res.updated ? " (" + res.updated + " updated)" : ""));
    } else if (manual) {
      toast("PennReach: " + (people.length ? "everyone on this page is already saved" : "no people found on this page"));
    }
    return res;
  }

  var timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () { capture(false).catch(function () {}); }, 900);
  }

  // LinkedIn is a single-page app: watch for result lists appearing and changing.
  new MutationObserver(function () { if (onSearchPage()) { schedule(); } })
    .observe(document.documentElement, { childList: true, subtree: true });
  schedule();

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === "capture") {
      capture(true).then(sendResponse, function (e) { sendResponse({ error: String(e) }); });
      return true;
    }
    return false;
  });

  self.PennReachLinkedIn = { extractPeople: extractPeople };
})();
