/*
 * End-to-end test: loads the unpacked extension in Chromium and drives the whole flow against
 * mock LinkedIn / Penn Directory / Gmail pages (fictional people only).
 *
 *   node extension/tests/e2e.js [--screenshots docs/]
 *
 * Needs Playwright with a full Chromium build (`npx playwright install chromium`).
 */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const EXT = path.resolve(__dirname, "..");
const shotsIdx = process.argv.indexOf("--screenshots");
const SHOTS = shotsIdx > 0 ? path.resolve(process.argv[shotsIdx + 1]) : null;

// ---- Mock LinkedIn results page (new-style layout: no <li>, no stable class names) ----
const card = (slug, name, head, loc, mutual = "") => `
<div class="r"><div class="r2">
  <a href="https://www.linkedin.com/in/${slug}/"><img alt=""></a>
  <div><div><p><a href="https://www.linkedin.com/in/${slug}/?trk=x"><span aria-hidden="true">${name}</span><span class="vh">View ${name}’s profile</span></a></p><p>· 2nd</p></div></div>
  <div><p>${head}</p><p>${loc}</p>${mutual}</div>
  <button>Connect</button>
</div></div>`;
const LINKEDIN = `<!doctype html><html><body><main><div class="results">
${card("taylor-brooks-example", "Taylor Brooks", "Stats @ Penn | Incoming @ Jane Street", "Philadelphia, PA",
  '<p><a href="https://www.linkedin.com/in/pat-mutual/">Pat Mutual</a> and 3 other mutual connections</p>')}
${card("jordan-lee-example", "Jordan Lee", "Incoming IB Analyst @ Goldman Sachs | Wharton '27", "New York, NY")}
${card("riley-park-example", "Riley Park", "Incoming SWE Intern @ Jane Street", "Wilmington, DE")}
${card("casey-nguyen-example", "Casey Nguyen", "Student at the University of Pennsylvania", "Philadelphia, PA")}
</div></main></body></html>`;

// ---- Mock Penn Directory (same FAST-framework structure as the real one) ----
const DIRECTORY_DB = {
  brooks: [["Brooks, Taylor Ann", "Student - Mathematics College of Arts & Sciences", "tbrooks@sas.upenn.edu"]],
  lee: [["Lee, Jordan A", "Student - Finance Wharton", "jlee1@wharton.upenn.edu"],
        ["Lee, Jordan B", "Student - CIS SEAS", "jlee2@seas.upenn.edu"]],
};
let loggedIn = false;
let fieldIds = null;
const rid = () => "W" + Math.random().toString(36).slice(2, 8).toUpperCase();
function formPage() {
  fieldIds = { first: rid(), aff: rid(), btn: rid() };
  return `<!doctype html><html><body>
  <a href="#" onclick="return fastGoToUrl(event, 'fast.do?fastButtonId=NAVSEARCH','','NAVSEARCH',false);" title="Search the Penn Directory"><img alt="Search"></a>
  <form name="searchPerson" id="searchPerson" method="post" action="fast.do"><input type="hidden" name="fastButtonId" />
  <table><tr><td>Last name:</td><td><input type="text" name="lastName"></td></tr>
  <tr><td>First name:</td><td><input type="text" name="${fieldIds.first}"></td></tr>
  <tr><td>Affiliation:</td><td><select name="${fieldIds.aff}"><option value="Any">Any</option><option value="STU">Student</option></select></td></tr></table>
  <a href="#" onclick="return fastSubmitForm(event, '${fieldIds.btn}', 'searchPerson', false, '',null,false);" class="submitButton"><span>Search</span></a>
  </form></body></html>`;
}
function resultsPage(params) {
  const last = (params.get("lastName") || "").toLowerCase();
  const first = (params.get(fieldIds.first) || "").toLowerCase();
  assert.equal(params.get(fieldIds.aff), "STU", "searches students only");
  assert.equal(params.get("fastButtonId"), fieldIds.btn, "submits with the Search button id");
  const rows = (DIRECTORY_DB[last] || []).filter(([n]) => !first || n.toLowerCase().includes(", " + first));
  const tr = rows.map(([n, aff, email]) => `<tr class="lookupbody"><td><a href="#">${n}</a></td><td>${aff}</td>
    <td>Email: ${loggedIn ? `<a href="mailto:${email}">${email}</a>` : '<a href="#"><span>[Login]</span></a>'}</td></tr>`).join("");
  return `<!doctype html><html><body>
  <a href="#" onclick="return fastGoToUrl(event, 'fast.do?fastButtonId=AGAIN','','AGAIN',false);" class="submitButton"><span>Search Again</span></a>
  <table>${tr}</table></body></html>`;
}

async function main() {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "pennreach-e2e-"));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: "chromium",
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    // Anything not mocked below goes to a dead proxy, so the test never touches the real internet.
    proxy: { server: "http://127.0.0.1:9" },
    viewport: { width: 420, height: 900 },
    deviceScaleFactor: SHOTS ? 2 : 1,
  });
  const directoryRequests = [];
  await ctx.route("https://www.linkedin.com/**", (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: LINKEDIN }));
  await ctx.route("https://directory.apps.upenn.edu/**", async (r) => {
    const req = r.request();
    if (!new URL(req.url()).pathname.endsWith("/fast.do")) { return r.fulfill({ status: 404, body: "" }); }
    directoryRequests.push(req.method());
    if (req.method() === "POST") {
      return r.fulfill({ contentType: "text/html; charset=utf-8", body: resultsPage(new URLSearchParams(req.postData() || "")) });
    }
    return r.fulfill({ contentType: "text/html; charset=utf-8", body: formPage() });
  });

  let [sw] = ctx.serviceWorkers();
  if (!sw) { sw = await ctx.waitForEvent("serviceworker"); }
  const extId = new URL(sw.url()).host;
  const panel = await ctx.newPage();
  const errs = [];
  panel.on("pageerror", (e) => errs.push(String(e)));
  panel.on("console", (m) => { if (m.type() === "error") { errs.push(m.text()); } });
  await panel.goto(`chrome-extension://${extId}/sidepanel/sidepanel.html`);
  const shot = async (name) => { if (SHOTS) { await panel.screenshot({ path: path.join(SHOTS, name), fullPage: true }); } };

  // 1. Onboarding
  await panel.getByText("Welcome to PennReach").waitFor();
  await shot("01-welcome.png");
  await panel.getByLabel("Your name").fill("Alex Chen");
  await panel.getByLabel("Major").fill("Economics");
  await panel.getByLabel("Interests").fill("finance and tech");
  await panel.getByLabel("Your Penn email").fill("alexchen@sas.upenn.edu");
  await panel.getByRole("button", { name: "Save & start" }).click();
  await panel.getByText("Collect people from LinkedIn").waitFor();

  // 2. Auto-collect from a LinkedIn search
  const li = await ctx.newPage();
  await li.goto("https://www.linkedin.com/search/results/people/?keywords=incoming");
  await li.locator("#pennreach-toast").waitFor({ state: "attached", timeout: 10000 });
  await panel.bringToFront();
  try { await panel.getByText("Matches (2)").waitFor({ timeout: 10000 }); } catch (e) { console.log("PANEL:", (await panel.locator("main").innerText()).slice(0, 1500)); console.log("STORE:", JSON.stringify(await sw.evaluate(() => chrome.storage.local.get(null))).slice(0, 2000)); throw e; }
  assert.equal(await panel.locator(".person .name", { hasText: "Pat Mutual" }).count(), 0, "mutual connections are not people");
  await panel.getByText("Filtered out (2)").click();
  await panel.getByText("Internship (SWE Intern)").waitFor();
  await shot("02-people.png");
  console.log("✓ auto-collect: 2 matches, 2 filtered (intern, not incoming), mutual ignored");

  // 3. Find emails: first run opens the directory, then logged out, then logged in
  await panel.getByRole("button", { name: /Next: find 2 Penn emails/ }).click();
  await panel.getByRole("button", { name: "Find emails for 2 people" }).click();
  await panel.getByText(/Opened the Penn Directory/).waitFor();
  let dirTab = null;
  for (let i = 0; i < 50 && !dirTab; i++) {
    dirTab = ctx.pages().find((p) => p.url().startsWith("https://directory.apps.upenn.edu"));
    if (!dirTab) { await panel.waitForTimeout(100); }
  }
  assert.ok(dirTab, "directory tab opened");
  // Tabs the extension opens skip Playwright's routing on their first load; reload through the mock.
  await dirTab.goto("https://directory.apps.upenn.edu/directory/jsp/fast.do");
  await panel.bringToFront();
  await panel.getByRole("button", { name: "Find emails for 2 people" }).click();
  await panel.getByText(/not logged in to the Penn Directory/).waitFor({ timeout: 15000 });
  console.log("✓ logged-out directory detected");

  loggedIn = true;
  await panel.bringToFront();
  await panel.getByRole("button", { name: "Find emails for 2 people" }).click();
  await panel.getByText(/Done: found 1 email, 1 need you to choose/).waitFor({ timeout: 30000 });
  await panel.getByText("Choose the right person (1)").waitFor();
  await shot("03-emails.png");
  await panel.locator(".candidate", { hasText: "jlee2@seas.upenn.edu" }).getByRole("button", { name: "Use" }).click();
  await panel.getByText("Found (2)").waitFor();
  assert.ok(directoryRequests.includes("POST"));
  console.log("✓ directory lookup: 1 auto-matched, 1 picked from 2 candidates");

  // 4. Send via Gmail
  await panel.getByRole("button", { name: "Next: review & send →" }).click();
  await panel.getByText("You can send 15 more today").waitFor();
  await shot("04-send.png");
  const taylorCard = panel.locator(".card", { hasText: "To: tbrooks@sas.upenn.edu" });
  try { await taylorCard.getByText("Hi Taylor,").waitFor({ timeout: 5000 }); } catch (e) { console.log("SEND:", (await taylorCard.innerHTML()).slice(0, 2500)); console.log("ERRS:", errs.join("\n")); throw e; }
  assert.match(await taylorCard.locator(".body").innerText(), /joining Jane Street after graduation/);
  const [gmail] = await Promise.all([ctx.waitForEvent("page"), taylorCard.getByRole("button", { name: "Open in Gmail" }).click()]);
  // Read the compose URL from Chrome's tab list (the request itself goes nowhere).
  let composeUrl = "";
  for (let i = 0; i < 50 && !composeUrl; i++) {
    const tabs = await panel.evaluate(() => chrome.tabs.query({}));
    const t = tabs.find((x) => (x.pendingUrl || x.url || "").startsWith("https://mail.google.com/"));
    composeUrl = t ? (t.pendingUrl || t.url) : "";
    if (!composeUrl) { await panel.waitForTimeout(100); }
  }
  const u = new URL(composeUrl);
  assert.equal(u.host, "mail.google.com");
  assert.equal(u.searchParams.get("to"), "tbrooks@sas.upenn.edu");
  assert.equal(u.searchParams.get("authuser"), "alexchen@sas.upenn.edu");
  assert.match(u.searchParams.get("body"), /^Hi Taylor,/);
  await gmail.close();
  await panel.bringToFront();
  await taylorCard.getByRole("button", { name: "Yes, sent ✓" }).click();
  console.log("✓ Gmail compose opened pre-filled; marked sent after confirmation");

  // Edit the other draft
  const jordanCard = panel.locator(".card", { hasText: "To: jlee2@seas.upenn.edu" });
  await jordanCard.getByRole("button", { name: "Edit" }).click();
  await jordanCard.getByLabel("Subject").fill("Wharton freshman, coffee?");
  await jordanCard.getByRole("button", { name: "Save" }).click();
  await jordanCard.getByText("Wharton freshman, coffee?").waitFor();
  console.log("✓ draft edits are saved");

  // 5. Tracker
  await panel.getByRole("tab", { name: "Tracker" }).click();
  await panel.locator(".stat", { hasText: "Sent" }).getByText("1").waitFor();
  await panel.getByRole("button", { name: "They replied" }).click();
  await panel.getByText("Replied", { exact: true }).first().waitFor();
  await shot("05-tracker.png");
  console.log("✓ tracker shows sent + reply");

  // 6. Daily cap blocks more sends
  await panel.locator("#settings-btn").click();
  await panel.getByLabel("Max emails per day").fill("1");
  await panel.getByRole("button", { name: "Save settings" }).click();
  await panel.getByRole("tab", { name: "3. Send" }).click();
  await panel.getByText("Daily limit reached").waitFor();
  assert.ok(await jordanCard.getByRole("button", { name: "Open in Gmail" }).isDisabled());
  console.log("✓ daily cap disables sending");

  await ctx.close();
  console.log("\nAll end-to-end checks passed.");
}

main().catch((e) => { console.error(e); process.exit(1); });
