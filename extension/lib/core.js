/*
 * PennReach core logic, shared by the side panel, content scripts and Node tests.
 * Plain script (no modules) so Chrome content scripts can load it: exposes `PennReachCore`.
 */
(function (root) {
  "use strict";

  // ---- Defaults ---------------------------------------------------------------------------

  var DEFAULT_FIRMS = [
    "Goldman Sachs", "Morgan Stanley", "J.P. Morgan", "Evercore", "Centerview",
    "PJT Partners", "Lazard", "Moelis", "Qatalyst", "Perella Weinberg", "Guggenheim",
    "Blackstone", "KKR", "Apollo", "Bain Capital", "Bridgewater",
    "Jane Street", "Citadel", "Citadel Securities", "Hudson River Trading", "Two Sigma",
    "D. E. Shaw", "Optiver", "SIG", "IMC",
    "McKinsey", "Bain & Company", "Boston Consulting Group", "Oliver Wyman", "Strategy&",
    "Google", "Meta", "Apple", "Microsoft", "Amazon", "Stripe", "Palantir", "OpenAI", "Anthropic",
  ];

  // Common headline spellings -> canonical firm (applied only when the firm is in the target list).
  var BUILTIN_ALIASES = {
    "Goldman": "Goldman Sachs", "GS": "Goldman Sachs",
    "JPMorganChase": "J.P. Morgan", "JPMorgan Chase": "J.P. Morgan", "J.P. Morgan Chase": "J.P. Morgan",
    "JPMorgan": "J.P. Morgan", "JP Morgan": "J.P. Morgan", "J.P.Morgan": "J.P. Morgan", "JPMC": "J.P. Morgan",
    "Guggenheim Securities": "Guggenheim", "PWP": "Perella Weinberg",
    "BCG": "Boston Consulting Group", "Bain": "Bain & Company", "McKinsey & Company": "McKinsey",
    "DE Shaw": "D. E. Shaw", "D.E. Shaw": "D. E. Shaw", "HRT": "Hudson River Trading",
    "Susquehanna International Group": "SIG", "Susquehanna": "SIG",
  };

  var DEFAULT_TEMPLATE = {
    subject: "Penn freshman — coffee chat?",
    body: [
      "Hi {first_name},",
      "",
      "I'm {my_first_name}, a freshman in {my_school} studying {my_major}. I saw you'll be joining " +
        "{firm}{role_clause} after graduation — congrats! I'm really interested in {my_interests} and " +
        "would love to hear how you got there and what you wish you'd known as a freshman.",
      "",
      "Would you be open to grabbing coffee or a quick bite on campus sometime in the next few weeks? " +
        "Happy to work around your schedule (coffee's on me).",
      "",
      "Thanks so much,",
      "{my_name}",
      "Penn '{my_year_short}",
      "",
    ].join("\n"),
  };

  var FOLLOWUP_BODY = [
    "Hi {first_name},",
    "",
    "Just bumping this in case it got buried. I know senior fall is busy! " +
      "Even 15 minutes over coffee would mean a lot.",
    "",
    "Thanks,",
    "{my_first_name}",
    "",
  ].join("\n");

  // The senior class: academic years start in July, so Nov 2026 -> class of 2027.
  function currentSeniorYear(now) {
    now = now || new Date();
    return now.getMonth() >= 6 ? now.getFullYear() + 1 : now.getFullYear();
  }

  function defaultSettings(now) {
    return {
      me: { name: "", school: "the College", major: "", year: currentSeniorYear(now) + 3, interests: "", pennEmail: "" },
      targeting: {
        gradYears: [currentSeniorYear(now)],
        requireIncoming: true,
        excludeInterns: true,
        firms: DEFAULT_FIRMS.slice(),
      },
      template: { subject: DEFAULT_TEMPLATE.subject, body: DEFAULT_TEMPLATE.body },
      maxPerDay: 15,
      collecting: true,
    };
  }

  // ---- Text helpers -----------------------------------------------------------------------

  function squash(s) { return String(s == null ? "" : s).replace(/ /g, " ").replace(/\s+/g, " ").trim(); }
  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function cleanName(raw) {
    var name = String(raw || "").replace(/\(.*?\)/g, "");
    name = name.split(",")[0];
    name = name.replace(/[^\p{L}\p{M}\s.'’-]/gu, "");
    return squash(name);
  }

  function firstName(name) {
    var parts = cleanName(name).split(" ");
    return parts[0] || "";
  }

  // ---- Headline parsing ---------------------------------------------------------------------

  var INCOMING_RE = /\b(incoming|returning|future|joining)\b/i;
  var ROLE_RE = /\b(?:incoming|returning|future)\s+([^@|·•,;]+?)\s*(?:@|\bat\b|\||·|•|,)\s*(.*)/i;
  var YEAR_RES = [
    /(?:^|[^\w\d])(?:[CWEN]\s?)?['’‘](\d{2})(?!\d)/gi,
    /(?:^|[^\w\d])[CWEN](\d{2})(?!\d)/g,
    /(?:^|\D)20(\d{2})(?!\d)/g,
  ];

  function aliasesFor(firms) {
    var set = {};
    firms.forEach(function (f) { set[f] = true; });
    var out = {};
    Object.keys(BUILTIN_ALIASES).forEach(function (k) {
      if (set[BUILTIN_ALIASES[k]]) { out[k] = BUILTIN_ALIASES[k]; }
    });
    return out;
  }

  function matchFirm(text, firms, aliases) {
    var cands = firms.map(function (f) { return [f, f]; });
    Object.keys(aliases || {}).forEach(function (a) { cands.push([a, aliases[a]]); });
    cands.sort(function (x, y) { return y[0].length - x[0].length; }); // longest name wins
    for (var i = 0; i < cands.length; i++) {
      var needle = cands[i][0];
      var shortCaps = needle === needle.toUpperCase() && needle.length <= 4 && /[A-Z]/.test(needle);
      var re = new RegExp("(?:^|[^\\w])" + escapeRe(needle) + "(?![\\w])", shortCaps ? "" : "i");
      if (re.test(text)) { return cands[i][1]; }
    }
    return "";
  }

  function parseClassYear(text) {
    text = String(text || "");
    for (var i = 0; i < YEAR_RES.length; i++) {
      var re = new RegExp(YEAR_RES[i].source, YEAR_RES[i].flags);
      var m;
      while ((m = re.exec(text))) {
        var yy = parseInt(m[1], 10);
        if (yy >= 20 && yy <= 40) { return 2000 + yy; }
      }
    }
    return null;
  }

  function parseHeadline(headline, firms) {
    headline = squash(headline);
    var aliases = aliasesFor(firms);
    var role = "";
    var firm = "";
    var m = ROLE_RE.exec(headline);
    if (m) {
      role = m[1].replace(/^[\s\-–—]+|[\s\-–—]+$/g, "");
      firm = matchFirm(m[2], firms, aliases);
    }
    if (!firm) { firm = matchFirm(headline, firms, aliases); }
    return { isIncoming: INCOMING_RE.test(headline), firm: firm, role: role, classYear: parseClassYear(headline) };
  }

  var INTERN_RE = /(?:^|[^\w])(intern|internship|summer analyst|summer associate)(?![\w])/i;

  /** Decide whether a captured person matches the targeting settings. */
  function evaluate(person, settings) {
    var t = settings.targeting;
    var p = parseHeadline(person.headline || "", t.firms);
    var out = { firm: p.firm, role: p.role, classYear: p.classYear, keep: true, reason: "" };
    if (!person.headline) {
      out.keep = false; out.reason = "No headline captured";
    } else if (t.firms.length && !p.firm) {
      out.keep = false; out.reason = "Not at a target firm";
    } else if (t.requireIncoming && !p.isIncoming) {
      out.keep = false; out.reason = "Doesn't say incoming/returning";
    } else if (t.gradYears.length && p.classYear && t.gradYears.indexOf(p.classYear) < 0) {
      out.keep = false; out.reason = "Class of " + p.classYear;
    } else if (t.excludeInterns && INTERN_RE.test(p.role)) {
      out.keep = false; out.reason = "Internship (" + p.role + ")";
    }
    return out;
  }

  // ---- Emails -----------------------------------------------------------------------------

  var PENN_EMAIL_RE = /^[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)*upenn\.edu$/i;
  var PENN_EMAIL_IN_TEXT_RE = /[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)*upenn\.edu/i;

  function isPennEmail(s) { return PENN_EMAIL_RE.test(String(s || "").trim()); }
  function extractPennEmail(s) {
    var m = PENN_EMAIL_IN_TEXT_RE.exec(String(s || ""));
    return m ? m[0].toLowerCase() : "";
  }

  /** Split a captured name into the first/last used for a directory search, or null. */
  function searchName(name) {
    var parts = cleanName(name).split(" ").filter(Boolean);
    if (parts.length < 2 || /\.$/.test(parts[parts.length - 1])) { return null; } // "Jane D."
    return { first: parts[0], last: parts[parts.length - 1] };
  }

  /**
   * Choose an email from directory rows [{name: "Doe, Jane M", affiliation, email}].
   * Returns {email} for a confident single match, {candidates: [...]} when the user must pick,
   * or {none: true}.
   */
  function pickEmail(personName, rows) {
    var first = firstName(personName).toLowerCase();
    var cands = [];
    rows.forEach(function (r) {
      String(r.email || "").split(/\s+/).forEach(function (e) {
        if (isPennEmail(e)) { cands.push({ name: r.name, affiliation: r.affiliation, email: e.toLowerCase() }); }
      });
    });
    var exact = cands.filter(function (c) {
      var rest = (c.name.split(",")[1] || "").trim().split(" ")[0] || "";
      return rest.toLowerCase() === first;
    });
    if (uniqueEmails(exact).length === 1) { cands = exact; }
    var uniq = [];
    cands.forEach(function (c) {
      if (!uniq.some(function (u) { return u.email === c.email; })) { uniq.push(c); }
    });
    if (!uniq.length) { return { none: true }; }
    if (uniq.length === 1) { return { email: uniq[0].email, match: uniq[0] }; }
    return { candidates: uniq };
  }
  function uniqueEmails(list) {
    var seen = {};
    return list.filter(function (c) { if (seen[c.email]) { return false; } seen[c.email] = true; return true; });
  }

  // ---- Drafting ---------------------------------------------------------------------------

  function article(word) { return /^[aeiou]/i.test(word) ? "an" : "a"; }

  function templateFields(person, ev, me) {
    var name = cleanName(person.name);
    var role = squash(ev.role);
    var year = me.year ? String(me.year) : "";
    return {
      name: name,
      first_name: firstName(name),
      last_name: name.split(" ").pop() || "",
      firm: ev.firm || "your firm",
      role: role,
      role_clause: role ? " as " + article(role) + " " + role : "",
      my_name: me.name || "",
      my_first_name: firstName(me.name || ""),
      my_school: me.school || "",
      my_major: me.major || "",
      my_interests: me.interests || "",
      my_year: year,
      my_year_short: year.slice(-2),
      my_email: me.pennEmail || "",
    };
  }

  function render(template, fields) {
    return String(template).replace(/\{(\w+)\}/g, function (all, key) {
      return Object.prototype.hasOwnProperty.call(fields, key) ? fields[key] : all;
    });
  }

  function unknownPlaceholders(template, fields) {
    var out = [];
    String(template).replace(/\{(\w+)\}/g, function (all, key) {
      if (!Object.prototype.hasOwnProperty.call(fields, key) && out.indexOf(key) < 0) { out.push(key); }
      return all;
    });
    return out;
  }

  /** The email for a person: their saved edits if any, otherwise rendered from the template. */
  function draftFor(person, settings) {
    var ev = evaluate(person, settings);
    var f = templateFields(person, ev, settings.me);
    return {
      subject: person.subjectOverride != null ? person.subjectOverride : render(settings.template.subject, f),
      body: person.bodyOverride != null ? person.bodyOverride : render(settings.template.body, f),
    };
  }

  function followupFor(person, settings) {
    var ev = evaluate(person, settings);
    var f = templateFields(person, ev, settings.me);
    var subject = (person.sentSubject || draftFor(person, settings).subject);
    return { subject: /^re:/i.test(subject) ? subject : "Re: " + subject, body: render(FOLLOWUP_BODY, f) };
  }

  function gmailComposeUrl(to, subject, body, account) {
    var q = encodeURIComponent;
    var params = "view=cm&fs=1&to=" + q(to) + "&su=" + q(subject) + "&body=" + q(body);
    if (account) { params = "authuser=" + q(account) + "&" + params; }
    return "https://mail.google.com/mail/?" + params;
  }

  // ---- Limits -----------------------------------------------------------------------------

  function sentInLast24h(people, now) {
    var cutoff = (now || Date.now()) - 24 * 3600 * 1000;
    return people.filter(function (p) { return p.sentAt && p.sentAt >= cutoff; }).length;
  }

  // ---- CSV --------------------------------------------------------------------------------

  var CSV_COLUMNS = ["name", "headline", "location", "linkedin_url", "email", "status", "firm", "sent_at", "notes"];

  function csvCell(s) {
    s = String(s == null ? "" : s);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCsv(people, settings) {
    var rows = [CSV_COLUMNS];
    people.forEach(function (p) {
      var ev = evaluate(p, settings);
      rows.push([p.name, p.headline, p.location, p.linkedin_url, p.email, p.status, ev.firm,
        p.sentAt ? new Date(p.sentAt).toISOString() : "", p.notes]);
    });
    return rows.map(function (r) { return r.map(csvCell).join(","); }).join("\n");
  }

  function parseCsv(text) {
    var rows = [];
    var row = [];
    var cell = "";
    var inQ = false;
    text = String(text).replace(/^﻿/, "");
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') { inQ = false; }
        else { cell += ch; }
      } else if (ch === '"') { inQ = true; }
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") { i++; }
        row.push(cell); rows.push(row); row = []; cell = "";
      } else { cell += ch; }
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    if (!rows.length) { return []; }
    var head = rows[0].map(function (h) { return h.trim().toLowerCase(); });
    return rows.slice(1).filter(function (r) { return r.some(Boolean); }).map(function (r) {
      var o = {};
      head.forEach(function (h, k) { o[h] = (r[k] || "").trim(); });
      return o;
    });
  }

  function normalizeLinkedinUrl(href) {
    var m = String(href || "").match(/linkedin\.com\/in\/([^/?#]+)|^\/in\/([^/?#]+)/);
    return m ? "https://www.linkedin.com/in/" + (m[1] || m[2]) : "";
  }

  var api = {
    DEFAULT_FIRMS: DEFAULT_FIRMS, DEFAULT_TEMPLATE: DEFAULT_TEMPLATE, BUILTIN_ALIASES: BUILTIN_ALIASES,
    currentSeniorYear: currentSeniorYear, defaultSettings: defaultSettings,
    squash: squash, cleanName: cleanName, firstName: firstName,
    matchFirm: matchFirm, aliasesFor: aliasesFor, parseClassYear: parseClassYear, parseHeadline: parseHeadline,
    evaluate: evaluate,
    isPennEmail: isPennEmail, extractPennEmail: extractPennEmail, searchName: searchName, pickEmail: pickEmail,
    templateFields: templateFields, render: render, unknownPlaceholders: unknownPlaceholders,
    draftFor: draftFor, followupFor: followupFor, gmailComposeUrl: gmailComposeUrl,
    sentInLast24h: sentInLast24h, toCsv: toCsv, parseCsv: parseCsv, normalizeLinkedinUrl: normalizeLinkedinUrl,
  };
  if (typeof module !== "undefined" && module.exports) { module.exports = api; }
  else { root.PennReachCore = api; }
})(typeof self !== "undefined" ? self : this);
