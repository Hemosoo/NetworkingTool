// Run: node --test extension/tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const Core = require("../lib/core.js");

const FIRMS = ["Goldman Sachs", "Citadel", "Citadel Securities", "Bain Capital", "Bain & Company",
  "SIG", "J.P. Morgan", "Jane Street", "McKinsey", "Evercore", "Strategy&"];

function settings(over = {}) {
  const s = Core.defaultSettings(new Date("2026-11-20"));
  s.targeting.firms = FIRMS;
  s.me = { name: "Alex Chen", school: "the College", major: "Economics", year: 2030, interests: "finance", pennEmail: "alexchen@sas.upenn.edu" };
  return Object.assign(s, over);
}

test("senior class year rolls over in July", () => {
  assert.equal(Core.currentSeniorYear(new Date("2026-11-20")), 2027);
  assert.equal(Core.currentSeniorYear(new Date("2027-03-01")), 2027);
  assert.equal(Core.currentSeniorYear(new Date("2027-08-01")), 2028);
});

test("parses incoming role, firm and class year", () => {
  const p = Core.parseHeadline("Incoming IB Analyst @ Goldman Sachs | Wharton '27", FIRMS);
  assert.deepEqual([p.isIncoming, p.firm, p.role, p.classYear], [true, "Goldman Sachs", "IB Analyst", 2027]);
  const r = Core.parseHeadline("Returning Trader at Citadel Securities", FIRMS);
  assert.deepEqual([r.firm, r.role], ["Citadel Securities", "Trader"]);
});

test("firm matching: longest wins, aliases, short caps are case-sensitive", () => {
  assert.equal(Core.matchFirm("Bain Capital PE", FIRMS, Core.aliasesFor(FIRMS)), "Bain Capital");
  assert.equal(Core.parseHeadline("Incoming Associate Consultant, Bain", FIRMS).firm, "Bain & Company");
  assert.equal(Core.parseHeadline("Econ @ Penn | Incoming @JPMorganChase", FIRMS).firm, "J.P. Morgan");
  assert.equal(Core.parseHeadline("Incoming Intern at Susquehanna International Group", FIRMS).firm, "SIG");
  assert.equal(Core.parseHeadline("UPenn Alumna | Incoming Associate at Strategy&", FIRMS).firm, "Strategy&");
  assert.equal(Core.matchFirm("designer", FIRMS, {}), "");
  assert.equal(Core.matchFirm("gs rocks", ["Goldman Sachs"], { GS: "Goldman Sachs" }), "");
});

test("class years", () => {
  for (const [t, y] of [["Penn C'27", 2027], ["W27", 2027], ["Class of 2028", 2028], ["Penn ’26", 2026]]) {
    assert.equal(Core.parseClassYear(t), y, t);
  }
  assert.equal(Core.parseClassYear("24/7 hustle"), null);
});

test("evaluate keeps incoming seniors at target firms and explains the rest", () => {
  const s = settings();
  const ev = (headline) => Core.evaluate({ name: "X Y", headline }, s);
  assert.equal(ev("Math @ Penn | Incoming @ Jane Street").keep, true);
  assert.equal(ev("Incoming Analyst at Some Startup").reason, "Not at a target firm");
  assert.equal(ev("Student at the University of Pennsylvania").reason, "Not at a target firm");
  assert.equal(ev("Analyst at Goldman Sachs").reason, "Doesn't say incoming/returning");
  assert.equal(ev("Incoming Summer Analyst @ Evercore | Wharton '28").reason, "Class of 2028");
  assert.match(ev("Incoming SWE Intern @ Jane Street").reason, /Internship/);
  assert.equal(ev("").reason, "No headline captured");
});

test("names", () => {
  assert.equal(Core.cleanName("Priya Patel (she/her) 🚀"), "Priya Patel");
  assert.equal(Core.cleanName("Jane Doe, CFA"), "Jane Doe");
  assert.equal(Core.firstName("Mary-Kate O'Neil"), "Mary-Kate");
  assert.deepEqual(Core.searchName("Taylor Ann Brooks"), { first: "Taylor", last: "Brooks" });
  assert.equal(Core.searchName("Sam L."), null);
});

test("penn email validation and extraction", () => {
  assert.ok(Core.isPennEmail("jdoe@wharton.upenn.edu"));
  assert.ok(!Core.isPennEmail("jdoe@gmail.com"));
  assert.ok(!Core.isPennEmail("jdoe@upenn.edu.evil.com"));
  assert.equal(Core.extractPennEmail("Doe, Jane  JDoe@SEAS.upenn.edu  CIS"), "jdoe@seas.upenn.edu");
});

test("pickEmail: single, first-name preference, ambiguous, none", () => {
  const one = Core.pickEmail("Taylor Brooks", [{ name: "Brooks, Taylor Ann", affiliation: "Student", email: "tb@sas.upenn.edu" }]);
  assert.equal(one.email, "tb@sas.upenn.edu");
  const pref = Core.pickEmail("Taylor Brooks", [
    { name: "Brooks, Taylor", affiliation: "Student", email: "tb@sas.upenn.edu" },
    { name: "Brooks, Jordan", affiliation: "Student", email: "jb@seas.upenn.edu" }]);
  assert.equal(pref.email, "tb@sas.upenn.edu");
  const amb = Core.pickEmail("Jordan Lee", [
    { name: "Lee, Jordan A", affiliation: "Wharton", email: "jlee1@wharton.upenn.edu" },
    { name: "Lee, Jordan B", affiliation: "SEAS", email: "jlee2@seas.upenn.edu" }]);
  assert.equal(amb.candidates.length, 2);
  assert.ok(Core.pickEmail("Morgan Reyes", [{ name: "Reyes, Morgan", affiliation: "Student", email: "" }]).none);
});

test("drafts render personal fields, and saved edits win", () => {
  const s = settings();
  const p = { name: "Priya Patel (she/her)", headline: "Returning Software Engineer at Jane Street" };
  const d = Core.draftFor(p, s);
  assert.equal(d.subject, "Penn freshman — coffee chat?");
  assert.match(d.body, /^Hi Priya,/);
  assert.match(d.body, /joining Jane Street as a Software Engineer after graduation/);
  assert.match(d.body, /Alex Chen\nPenn '30/);
  const edited = Core.draftFor(Object.assign({ subjectOverride: "Hey!", bodyOverride: "Custom" }, p), s);
  assert.deepEqual(edited, { subject: "Hey!", body: "Custom" });
  assert.deepEqual(Core.unknownPlaceholders("Hi {nickname} {first_name}", Core.templateFields(p, { firm: "", role: "" }, s.me)), ["nickname"]);
  const f = Core.followupFor(Object.assign({ sentSubject: "Coffee?" }, p), s);
  assert.equal(f.subject, "Re: Coffee?");
});

test("gmail compose url encodes everything and picks the Penn account", () => {
  const body = "Hi Taylor,\n\nCoffee & a chat? 100% my treat — thanks!\n";
  const u = new URL(Core.gmailComposeUrl("tb@sas.upenn.edu", "Coffee & chat?", body, "me@sas.upenn.edu"));
  assert.equal(u.origin + u.pathname, "https://mail.google.com/mail/");
  assert.equal(u.searchParams.get("to"), "tb@sas.upenn.edu");
  assert.equal(u.searchParams.get("su"), "Coffee & chat?");
  assert.equal(u.searchParams.get("body"), body);
  assert.equal(u.searchParams.get("authuser"), "me@sas.upenn.edu");
  assert.equal(u.searchParams.get("view"), "cm");
});

test("daily cap counts a rolling 24h window", () => {
  const now = Date.now();
  const people = [{ sentAt: now - 3600e3 }, { sentAt: now - 25 * 3600e3 }, {}];
  assert.equal(Core.sentInLast24h(people, now), 1);
});

test("csv round trip with quotes, commas and newlines", () => {
  const s = settings();
  const people = [{ name: 'Jordan "JJ" Lee', headline: "Incoming Analyst, Goldman Sachs", location: "Philadelphia, PA",
    linkedin_url: "https://www.linkedin.com/in/jordan-lee-example", email: "jl@upenn.edu", status: "sent", notes: "line1\nline2" }];
  const rows = Core.parseCsv(Core.toCsv(people, s));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Jordan "JJ" Lee');
  assert.equal(rows[0].location, "Philadelphia, PA");
  assert.equal(rows[0].firm, "Goldman Sachs");
  assert.equal(rows[0].notes, "line1\nline2");
  assert.equal(Core.normalizeLinkedinUrl("/in/abc-123?miniProfileUrn=x"), "https://www.linkedin.com/in/abc-123");
});
