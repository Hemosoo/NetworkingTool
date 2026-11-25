/*
 * PennReach storage on chrome.storage.local (stays on this computer).
 * Each person lives under its own key ("p:<linkedin url>") so the LinkedIn collector,
 * the directory lookup and the side panel can write at the same time without clobbering
 * each other. Exposes `PennReachStore`.
 */
(function (root) {
  "use strict";
  var Core = root.PennReachCore;
  var PREFIX = "p:";

  function key(url) { return PREFIX + url; }

  function mergeSettings(saved) {
    var d = Core.defaultSettings();
    saved = saved || {};
    return {
      me: Object.assign({}, d.me, saved.me),
      targeting: Object.assign({}, d.targeting, saved.targeting),
      template: Object.assign({}, d.template, saved.template),
      maxPerDay: saved.maxPerDay != null ? saved.maxPerDay : d.maxPerDay,
      collecting: saved.collecting != null ? saved.collecting : d.collecting,
    };
  }

  async function getSettings() {
    var got = await chrome.storage.local.get("settings");
    return mergeSettings(got.settings);
  }

  async function saveSettings(settings) {
    await chrome.storage.local.set({ settings: settings });
  }

  async function allPeople() {
    var all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter(function (k) { return k.indexOf(PREFIX) === 0; })
      .map(function (k) { return all[k]; })
      .sort(function (a, b) { return (a.capturedAt || 0) - (b.capturedAt || 0); });
  }

  async function getPerson(url) {
    var k = key(url);
    return (await chrome.storage.local.get(k))[k] || null;
  }

  async function updatePerson(url, fields) {
    var k = key(url);
    var cur = (await chrome.storage.local.get(k))[k];
    if (!cur) { return null; }
    var next = Object.assign({}, cur, fields);
    var obj = {};
    obj[k] = next;
    await chrome.storage.local.set(obj);
    return next;
  }

  /** Add people captured from LinkedIn. Fills in missing headlines; never duplicates. */
  async function addCaptured(list) {
    var clean = list.filter(function (p) { return p && p.linkedin_url && p.name; });
    if (!clean.length) { return { added: 0, updated: 0 }; }
    var keys = clean.map(function (p) { return key(p.linkedin_url); });
    var existing = await chrome.storage.local.get(keys);
    var toSet = {};
    var added = 0;
    var updated = 0;
    clean.forEach(function (p) {
      var k = key(p.linkedin_url);
      var cur = existing[k] || toSet[k];
      if (!cur) {
        toSet[k] = {
          name: p.name, headline: p.headline || "", location: p.location || "",
          linkedin_url: p.linkedin_url, email: p.email || "", status: p.email ? "ready" : "new",
          capturedAt: Date.now(),
        };
        added++;
      } else if (!cur.headline && p.headline) {
        toSet[k] = Object.assign({}, cur, { headline: p.headline, location: p.location || cur.location });
        updated++;
      }
    });
    if (Object.keys(toSet).length) { await chrome.storage.local.set(toSet); }
    return { added: added, updated: updated };
  }

  /** Is this address already emailed or opted out by someone else in the list? */
  async function emailBlocked(email, exceptUrl) {
    email = String(email || "").toLowerCase();
    var people = await allPeople();
    for (var i = 0; i < people.length; i++) {
      var p = people[i];
      if (p.linkedin_url === exceptUrl || String(p.email || "").toLowerCase() !== email) { continue; }
      if (p.status === "sent") { return "already emailed (" + p.name + ")"; }
      if (p.status === "do_not_contact") { return "on your do-not-contact list"; }
    }
    return "";
  }

  async function clearAll() {
    await chrome.storage.local.clear();
  }

  root.PennReachStore = {
    PREFIX: PREFIX, key: key, mergeSettings: mergeSettings,
    getSettings: getSettings, saveSettings: saveSettings,
    allPeople: allPeople, getPerson: getPerson, updatePerson: updatePerson,
    addCaptured: addCaptured, emailBlocked: emailBlocked, clearAll: clearAll,
  };
})(typeof self !== "undefined" ? self : this);
