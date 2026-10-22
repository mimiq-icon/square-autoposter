// test/e2e-alerts-weekly.test.mjs — v10.2. Runs the REAL post.mjs as a child
// process (RUN_MODE=alerts and RUN_MODE=weekly-approve) against a real local
// git remote with all network calls mocked (test-support/mock-fetch.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// --import needs a file:// URL on Windows (a bare C:\\ path throws ERR_UNSUPPORTED_ESM_URL_SCHEME)
const MOCK = pathToFileURL(path.join(ROOT, "test-support", "mock-fetch.mjs")).href;
let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const check = (name, cond, extra = "") => assert.ok(cond, `${name}${extra ? "\n" + extra : ""}`);

function world(seedPosted = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e2-"));
  const bare = path.join(root, "remote.git");
  sh(root, "init", "-q", "--bare", "-b", "main", bare);
  const seed = path.join(root, "seed");
  sh(root, "clone", "-q", bare, seed);
  // v11.1: post.mjs imports cards.mjs, research.mjs (v11) AND alerts.mjs,
  // article.mjs (restored v10.2), so a real run needs all of them.
  for (const f of ["post.mjs", "news.mjs", "news-sync.mjs", "telegram.mjs", "alerts.mjs", "article.mjs", "cards.mjs", "research.mjs"]) fs.copyFileSync(path.join(ROOT, f), path.join(seed, f));
  fs.mkdirSync(path.join(seed, "news-state"));
  fs.writeFileSync(path.join(seed, "news-state/posted.json"), JSON.stringify({ posted: seedPosted }) + "\n");
  const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
  sh(seed, ...id, "add", "-A"); sh(seed, ...id, "commit", "-q", "-m", "seed"); sh(seed, "branch", "-M", "main"); sh(seed, "push", "-q", "origin", "main");
  const clone = (n) => { const d = path.join(root, n); sh(root, "clone", "-q", bare, d); return d; };
  const remoteAlerts = () => { try { return JSON.parse(sh(bare, "show", "main:news-state/alerts.json")); } catch { return null; } };
  return { root, clone, remoteAlerts, mocklog: path.join(root, "mock.log") };
}
function run(cwd, mocklog, mode, extra = {}) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: os.homedir(), RUN_MODE: mode, BINANCE_SQUARE_OPENAPI_KEY: "x", GROQ_API_KEY: "x", NEWS_GIT_SYNC: "true", MOCK_LOG: mocklog, ...extra };
    const p = spawn(process.execPath, ["--import", MOCK, "post.mjs"], { cwd, env });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}
const lines = (w, prefix) => (fs.existsSync(w.mocklog) ? fs.readFileSync(w.mocklog, "utf8").split("\n").filter((l) => l.startsWith(prefix)) : []);
const posts = (w) => lines(w, "SQUARE ");

const GOOD_ALERT = "HEADLINE: Bitcoin drops below $83,000 and now trades at $82,950\nCONTEXT: It is down 1.2% over the past 24 hours.";

test("alerts 1: a quiet level cross posts once, text-only, with AI text, disclaimer and one cashtag; a rerun does not repost", { skip: !hasGit, timeout: 120000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "alerts", { MOCK_AI_TEXT: GOOD_ALERT });
  check("exit 0", r.code === 0, r.out.slice(-700));
  check("exactly one Square post", posts(w).length === 1, `got ${posts(w).length}\n${r.out.slice(-700)}`);
  const text = JSON.parse(posts(w)[0].slice(7));
  check("AI headline used", text.includes("🔻 Bitcoin drops below $83,000 and now trades at $82,950"), text);
  check("one cashtag, hashtags ≤2", (text.match(/\$[A-Z]{2,6}\b/g) || []).length === 1 && (text.match(/#\w+/g) || []).length <= 2 && /\$BTC #Bitcoin/.test(text), text);
  check("has a disclaimer line", /advice|DYOR|research/i.test(text), text);
  check("no image on a quiet level cross (images are for extreme moves)", lines(w, "IMAGELIST").length === 0, r.out.slice(-500));
  const st = w.remoteAlerts();
  check("shared state records the claim as posted", st && st.fired.length === 1 && st.fired[0].status === "posted" && st.fired[0].id === "BTC:level:down:83000", JSON.stringify(st));
  const again = await run(pc, w.mocklog, "alerts", { MOCK_AI_TEXT: GOOD_ALERT });
  check("rerun: no second post", again.code === 0 && posts(w).length === 1, again.out.slice(-400));
});

test("alerts 1b: an extreme move (-9% in 24h) gets an image; ALERT_CHART=off suppresses it; ALERT_CHART=all gives a quiet cross one", { skip: !hasGit, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "alerts", { MOCK_AI_TEXT: GOOD_ALERT, MOCK_BTC_CHG: "-9" });
  check("exit 0", r.code === 0, r.out.slice(-700));
  check("one post, with an image", posts(w).length === 1 && lines(w, "IMAGELIST").length === 1, r.out.slice(-700));
  const w2 = world(); const pc2 = w2.clone("pc");
  const r2 = await run(pc2, w2.mocklog, "alerts", { MOCK_AI_TEXT: GOOD_ALERT, MOCK_BTC_CHG: "-9", ALERT_CHART: "off" });
  check("off: one post, no image", r2.code === 0 && posts(w2).length === 1 && lines(w2, "IMAGELIST").length === 0, r2.out.slice(-700));
  const w3 = world(); const pc3 = w3.clone("pc");
  const r3 = await run(pc3, w3.mocklog, "alerts", { MOCK_AI_TEXT: GOOD_ALERT, ALERT_CHART: "all" });
  check("all: a quiet cross gets an image", r3.code === 0 && posts(w3).length === 1 && lines(w3, "IMAGELIST").length === 1, r3.out.slice(-700));
});

test("alerts 2: two machines at once post the alert exactly once", { skip: !hasGit, timeout: 120000 }, async () => {
  const w = world(); const pc = w.clone("pc"), gh = w.clone("gh");
  const [a, b] = await Promise.all([run(pc, w.mocklog, "alerts", { MOCK_AI_TEXT: GOOD_ALERT }), run(gh, w.mocklog, "alerts", { MOCK_AI_TEXT: GOOD_ALERT })]);
  check("both exit 0", a.code === 0 && b.code === 0, a.out.slice(-400) + b.out.slice(-400));
  check("exactly ONE post across both", posts(w).length === 1, `got ${posts(w).length}`);
  const st = w.remoteAlerts();
  check("one claim in shared state", st.fired.length === 1, JSON.stringify(st));
});

test("alerts 3: quiet market posts nothing", { skip: !hasGit, timeout: 60000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "alerts", { MOCK_BTC_START: "82950", MOCK_BTC_CHG: "0.2" });
  check("exit 0", r.code === 0, r.out.slice(-400));
  check("no post", posts(w).length === 0 && /No alert/.test(r.out), r.out.slice(-400));
});

test("alerts 4: an AI answer with an invented number is rejected and the data template is posted", { skip: !hasGit, timeout: 60000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "alerts", { MOCK_AI_TEXT: "HEADLINE: Bitcoin drops below $83,000 and now trades at $82,950\nCONTEXT: Analysts target $90,000 soon." });
  check("exit 0", r.code === 0, r.out.slice(-500));
  check("rejected then template", /rejected/.test(r.out) && posts(w).length === 1, r.out.slice(-600));
  const text = JSON.parse(posts(w)[0].slice(7));
  check("template headline posted", text.includes("Bitcoin falls below $83,000, now trading at $82,950") && !text.includes("90,000"), text);
});

test("alerts 5: Telegram approval — reject posts nothing and marks skipped; approve posts", { skip: !hasGit, timeout: 120000 }, async () => {
  for (const [mode, expectPosts, status] of [["reject", 0, "skipped"], ["approve", 1, "posted"]]) {
    const w = world(); const pc = w.clone("pc");
    const r = await run(pc, w.mocklog, "alerts", { MOCK_AI_TEXT: GOOD_ALERT, ALERT_APPROVAL: "all", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "111", MOCK_TG: mode });
    check(`${mode}: exit 0`, r.code === 0, r.out.slice(-600));
    check(`${mode}: ${expectPosts} post(s)`, posts(w).length === expectPosts, r.out.slice(-600));
    const st = w.remoteAlerts();
    check(`${mode}: status ${status}`, st.fired.length === 1 && st.fired[0].status === status, JSON.stringify(st));
  }
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "alerts", { ALERT_APPROVAL: "all" });
  check("approval=all without Telegram: does not post", r.code === 0 && posts(w).length === 0 && /not configured/i.test(r.out), r.out.slice(-300));
});

test("alerts 5b: with Telegram configured and ALERT_APPROVAL unset, it asks first; ALERT_APPROVAL=off posts without asking", { skip: !hasGit, timeout: 120000 }, async () => {
  let w = world(), pc = w.clone("pc");
  let r = await run(pc, w.mocklog, "alerts", { MOCK_AI_TEXT: GOOD_ALERT, TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "111", MOCK_TG: "reject" });
  check("asked on Telegram, nothing posted", r.code === 0 && lines(w, "telegram sent").length === 1 && posts(w).length === 0, r.out.slice(-500));
  w = world(); pc = w.clone("pc");
  r = await run(pc, w.mocklog, "alerts", { MOCK_AI_TEXT: GOOD_ALERT, TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "111", ALERT_APPROVAL: "off" });
  check("approval off: posted with no Telegram prompt", r.code === 0 && lines(w, "telegram sent").length === 0 && posts(w).length === 1, r.out.slice(-500));
});

test("alerts 6: Binance down, chart failure, daily-limit error, and dry run", { skip: !hasGit, timeout: 120000 }, async () => {
  let w = world(), pc = w.clone("pc");
  let r = await run(pc, w.mocklog, "alerts", { MOCK_BINANCE: "fail" });
  check("Binance down: exit 0, no post", r.code === 0 && posts(w).length === 0 && /Could not read Binance prices/.test(r.out), r.out.slice(-400));

  w = world(); pc = w.clone("pc");
  r = await run(pc, w.mocklog, "alerts", { MOCK_KLINES: "fail", MOCK_BTC_CHG: "-7", MOCK_BTC_START: "82950" });
  check("no candles: still a 24h-move alert, text only", r.code === 0 && posts(w).length === 1 && lines(w, "IMAGELIST").length === 0, r.out.slice(-500));

  w = world(); pc = w.clone("pc");
  r = await run(pc, w.mocklog, "alerts", { MOCK_SQUARE: "limit" });
  check("220009: exit 0, friendly message, claim released", r.code === 0 && /daily API post limit/i.test(r.out) && w.remoteAlerts().fired.length === 0, r.out.slice(-500) + JSON.stringify(w.remoteAlerts()));

  w = world(); pc = w.clone("pc");
  r = await run(pc, w.mocklog, "alerts", { DRY_RUN: "true", MOCK_AI_TEXT: GOOD_ALERT });
  check("dry run: nothing published, nothing pushed", r.code === 0 && posts(w).length === 0 && w.remoteAlerts() === null && /Would publish/.test(r.out), r.out.slice(-500));
});

// ------------------------------------------------------------- weekly ----

const FILLER = "The figures give a mixed picture and the data alone does not explain the moves. ".repeat(6);
const ARTICLE = [
  "TITLE: Bitcoin holds steady as sentiment stays in greed territory",
  "BODY:",
  "## Market snapshot",
  `The total crypto market cap is $2.74T, with a 24h change of -0.50%, and Bitcoin dominance is 60.1%. The Fear & Greed Index reads 59/100 (Greed). ${FILLER}`,
  "## The majors",
  `Bitcoin trades at $82,950.00 with a 24h change of -1.20% and a 7-day change of +3.40%. Ethereum is at $3,500.00. ${FILLER}`,
  "## Stories that shaped the week",
  `According to CoinDesk, the SEC approves spot Solana ETF from Grayscale. ${FILLER}`,
  "## Reading the data",
  FILLER,
  "This is not financial advice.",
].join("\n");
const SEEDED = [{ title: "SEC approves spot Solana ETF from Grayscale", link: "https://x.test/a", source: "CoinDesk", at: Date.now() - 3600_000, status: "posted" }];
const TG = { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "111" };

test("weekly 1: AI article is sent to Telegram in full, and published only after Post", { skip: !hasGit, timeout: 120000 }, async () => {
  for (const [mode, expectPosts] of [["approve", 1], ["reject", 0]]) {
    const w = world(SEEDED); const pc = w.clone("pc");
    const r = await run(pc, w.mocklog, "weekly-approve", { MOCK_AI_TEXT: ARTICLE, MOCK_TG: mode, ...TG });
    check(`${mode}: exit 0`, r.code === 0, r.out.slice(-1500));
    check(`${mode}: AI article validated, not the template`, /article validated/.test(r.out) && !/using the data template/.test(r.out), r.out.slice(-1500));
    check(`${mode}: full text sent as plain Telegram messages, then the approval buttons`, lines(w, "telegram text").length >= 1 && lines(w, "telegram sent").length === 1, r.out.slice(-800));
    check(`${mode}: ${expectPosts} article post(s)`, posts(w).length === expectPosts, r.out.slice(-800));
    if (expectPosts) {
      const body = JSON.parse(posts(w)[0].slice(7));
      check("published as an article with title, content and a chart cover", body.title === "Bitcoin holds steady as sentiment stays in greed territory" && /## Market snapshot/.test(body.content) && lines(w, "COVERLIST").length === 1, JSON.stringify(body).slice(0, 300));
    }
  }
});

test("weekly 2: an article with an invented number falls back to the data template (still needs your tap)", { skip: !hasGit, timeout: 120000 }, async () => {
  const w = world(SEEDED); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "weekly-approve", { MOCK_AI_TEXT: ARTICLE.replace("$82,950.00", "$91,230.00"), MOCK_TG: "reject", ...TG });
  check("exit 0", r.code === 0, r.out.slice(-800));
  check("rejected, template used, Telegram still asked", /rejected/.test(r.out) && /using the data template/.test(r.out) && lines(w, "telegram sent").length === 1 && posts(w).length === 0, r.out.slice(-1000));
});

test("weekly 3: no Telegram => refuses (nothing is ever published unapproved); dry run sends and posts nothing", { skip: !hasGit, timeout: 120000 }, async () => {
  let w = world(SEEDED), pc = w.clone("pc");
  let r = await run(pc, w.mocklog, "weekly-approve", { MOCK_AI_TEXT: ARTICLE });
  check("exits non-zero with a clear message", r.code !== 0 && /Telegram is not configured/.test(r.out) && posts(w).length === 0, r.out.slice(-500));
  w = world(SEEDED); pc = w.clone("pc");
  r = await run(pc, w.mocklog, "weekly-approve", { MOCK_AI_TEXT: ARTICLE, DRY_RUN: "true", ...TG });
  check("dry run: nothing sent or posted, draft saved", r.code === 0 && posts(w).length === 0 && lines(w, "telegram").length === 0 && fs.existsSync(path.join(pc, "weekly-draft.json")), r.out.slice(-600));
});
