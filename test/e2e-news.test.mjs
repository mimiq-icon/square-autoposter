// test/e2e-news.test.mjs — runs the REAL post.mjs (RUN_MODE=news) as a child
// process against a real local bare git remote, with fetch mocked
// (test-support/mock-fetch.mjs). This is what proves the duplicate-post lock:
// two "machines" (two clones) run at the same moment and exactly one Square
// post comes out. Skipped automatically if git isn't installed.
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

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  const bare = path.join(root, "remote.git");
  sh(root, "init", "-q", "--bare", "-b", "main", bare);
  const seed = path.join(root, "seed");
  sh(root, "clone", "-q", bare, seed);
  // v11: post.mjs imports cards.mjs and research.mjs, so a real run needs
  // them in the clone too. v11.1: alerts.mjs and article.mjs as well.
  for (const f of ["post.mjs", "news.mjs", "news-sync.mjs", "telegram.mjs", "cards.mjs", "research.mjs", "alerts.mjs", "article.mjs"]) fs.copyFileSync(path.join(ROOT, f), path.join(seed, f));
  fs.mkdirSync(path.join(seed, "news-state"));
  fs.writeFileSync(path.join(seed, "news-state/posted.json"), '{"posted":[]}\n');
  const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
  sh(seed, ...id, "add", "-A");
  sh(seed, ...id, "commit", "-q", "-m", "seed");
  sh(seed, "branch", "-M", "main");
  sh(seed, "push", "-q", "origin", "main");
  const clone = (n) => { const d = path.join(root, n); sh(root, "clone", "-q", bare, d); return d; };
  const remoteState = () => JSON.parse(sh(bare, "show", "main:news-state/posted.json"));
  return { root, bare, clone, remoteState, mocklog: path.join(root, "mock.log") };
}
function run(cwd, mocklog, extra = {}) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: os.homedir(), RUN_MODE: "news", BINANCE_SQUARE_OPENAPI_KEY: "x", GROQ_API_KEY: "x", NEWS_GIT_SYNC: "true", NEWS_MIN_GAP_MIN: "0", MOCK_LOG: mocklog, ...extra };
    const p = spawn(process.execPath, ["--import", MOCK, "post.mjs"], { cwd, env });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}
const posts = (w) => (fs.existsSync(w.mocklog) ? fs.readFileSync(w.mocklog, "utf8").split("\n").filter((l) => l.startsWith("SQUARE")) : []);
const mlog = (w, s) => (fs.existsSync(w.mocklog) ? fs.readFileSync(w.mocklog, "utf8").includes(s) : false);

test("e2e 1: two machines at once post a story exactly once", { skip: !hasGit, timeout: 120000 }, async () => {
{
  const w = world(); const pc = w.clone("pc"), gh = w.clone("gh");
  const [a, b] = await Promise.all([run(pc, w.mocklog), run(gh, w.mocklog)]);
  check("1 race: both exit 0", a.code === 0 && b.code === 0, a.out.slice(-400) + b.out.slice(-400));
  check("1 race: exactly ONE Square post across both machines", posts(w).length === 1, `got ${posts(w).length}`);
  const st = w.remoteState();
  check("1 race: shared state has the story once, status posted", st.posted.length === 1 && st.posted[0].status === "posted", JSON.stringify(st));
  const again = await run(gh, w.mocklog);
  check("1 race: a later run (either machine) does not repost", posts(w).length === 1 && again.code === 0, again.out.slice(-300));
  const after = await run(pc, w.mocklog);
  check("1 race: pc catches up from remote and does not repost", posts(w).length === 1, after.out.slice(-300));
}
});

test("e2e 2: Telegram approve / reject / timeout", { skip: !hasGit, timeout: 120000 }, async () => {
for (const [mode, expectPosts, expectStatus, extra] of [["approve", 1, "posted", {}], ["reject", 0, "skipped", {}], ["none", 0, "skipped", { NEWS_APPROVAL_WAIT_MIN: "0.04" }]]) {
  extra.NEWS_APPROVAL = "all";
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "111", MOCK_TG: mode, ...extra });
  check(`2 telegram ${mode}: exit 0`, r.code === 0, r.out.slice(-500));
  check(`2 telegram ${mode}: asked on Telegram`, mlog(w, "telegram sent"), r.out.slice(-500));
  check(`2 telegram ${mode}: ${expectPosts} post(s)`, posts(w).length === expectPosts, `got ${posts(w).length}\n${r.out.slice(-600)}`);
  const st = w.remoteState();
  check(`2 telegram ${mode}: remote state status ${expectStatus}`, st.posted.length === 1 && st.posted[0].status === expectStatus, JSON.stringify(st));
  const r2 = await run(pc, w.mocklog, { TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "111", MOCK_TG: mode, ...extra });
  check(`2 telegram ${mode}: second run does not ask again / repost`, posts(w).length === expectPosts && r2.code === 0, r2.out.slice(-300));
}
});

test("e2e 2b: sensitive stories: single outlet waits, two outlets ask a human", { skip: !hasGit, timeout: 120000 }, async () => {
{
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, { MOCK_STORY: "hack-single", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "111", MOCK_TG: "approve" });
  check("2b hack, one outlet: held (no post, no Telegram ask, no claim)", posts(w).length === 0 && !mlog(w, "telegram sent") && w.remoteState().posted.length === 0, r.out.slice(-500));
  const w2 = world(); const pc2 = w2.clone("pc");
  const r2 = await run(pc2, w2.mocklog, { MOCK_STORY: "hack-double", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "111", MOCK_TG: "reject" });
  check("2b hack, two outlets + Telegram: asks the human, rejection blocks it", mlog(w2, "telegram sent") && posts(w2).length === 0 && w2.remoteState().posted[0]?.status === "skipped", r2.out.slice(-500));
  const w3 = world(); const pc3 = w3.clone("pc");
  const r3 = await run(pc3, w3.mocklog, { MOCK_STORY: "hack-double", TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "111", MOCK_TG: "approve" });
  check("2b hack, two outlets + Telegram approve: posts once", posts(w3).length === 1 && w3.remoteState().posted[0]?.status === "posted", r3.out.slice(-500));
  const w4 = world(); const pc4 = w4.clone("pc");
  const r4 = await run(pc4, w4.mocklog, { MOCK_STORY: "hack-double" });
  check("2b hack, two outlets, no Telegram configured: posts (confirmed by 2 outlets)", posts(w4).length === 1, r4.out.slice(-500));
}
});

test("e2e 3: a failed publish releases the claim", { skip: !hasGit, timeout: 120000 }, async () => {
{
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, { MOCK_SQUARE: "fail" });
  check("3 publish failure: exits non-zero", r.code !== 0, r.out.slice(-300));
  check("3 publish failure: claim released from shared state", w.remoteState().posted.length === 0, JSON.stringify(w.remoteState()));
  const r2 = await run(pc, w.mocklog);
  check("3 publish failure: next run posts it", posts(w).length === 1 && r2.code === 0, r2.out.slice(-300));
}
});

test("e2e 4: AI provider order, fallback and validation", { skip: !hasGit, timeout: 120000 }, async () => {
{
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, { OLLAMA_MODEL: "qwen2.5:3b", AI_PROVIDER_ORDER: "ollama,groq", NEWS_GIT_SYNC: "false" });
  check("4 ollama: used and think-tags stripped", mlog(w, "ollama call") && !mlog(w, "groq call") && posts(w).length === 1 && !posts(w)[0].includes("hmm"), r.out.slice(-500));
  const w2 = world(); const pc2 = w2.clone("pc");
  const r2 = await run(pc2, w2.mocklog, { OLLAMA_MODEL: "qwen2.5:3b", AI_PROVIDER_ORDER: "ollama,groq", MOCK_OLLAMA: "down" });
  check("4 ollama down: falls back to groq and still posts once", mlog(w2, "groq call") && posts(w2).length === 1, r2.out.slice(-500));
  const w3 = world(); const pc3 = w3.clone("pc");
  const r3 = await run(pc3, w3.mocklog, { MOCK_AI: "bad" });
  check("4 bad AI: validator rejects, template fallback posts once", posts(w3).length === 1 && !posts(w3)[0].includes("$9 billion"), r3.out.slice(-500));
  const w4 = world(); const pc4 = w4.clone("pc");
  const r4 = await run(pc4, w4.mocklog, { MOCK_AI: "bad", NEWS_REQUIRE_AI: "true" });
  check("4 bad AI + NEWS_REQUIRE_AI: nothing posted, story marked skipped", posts(w4).length === 0 && w4.remoteState().posted[0]?.status === "skipped", r4.out.slice(-500));
}
});

test("e2e 5: feed caching (304) and total feed failure", { skip: !hasGit, timeout: 120000 }, async () => {
{
  const w = world(); const pc = w.clone("pc"); const cache = path.join(w.root, "cache.json");
  await run(pc, w.mocklog, { NEWS_FEED_CACHE_FILE: cache, MOCK_ETAG: "1", NEWS_GIT_SYNC: "false", DRY_RUN: "true" });
  const r = await run(pc, w.mocklog, { NEWS_FEED_CACHE_FILE: cache, MOCK_ETAG: "1", NEWS_GIT_SYNC: "false", DRY_RUN: "true" });
  check("5 cache: second poll gets 304s and still sees the stories", mlog(w, "304 coindesk.com") && /coindesk\.com|CoinDesk: 2 items/.test(r.out) && /CoinDesk: 2 items/.test(r.out), r.out.slice(-600));
  const w2 = world(); const pc2 = w2.clone("pc");
  const r2 = await run(pc2, w2.mocklog, { MOCK_FEEDS: "fail" });
  check("5 all feeds fail: exits 0, posts nothing, no claim written", r2.code === 0 && posts(w2).length === 0 && w2.remoteState().posted.length === 0, r2.out.slice(-400));
}
});

test("e2e 6: dry run publishes and pushes nothing", { skip: !hasGit, timeout: 120000 }, async () => {
{
  const w = world(); const pc = w.clone("pc");
  const before = sh(w.bare, "rev-parse", "main");
  const r = await run(pc, w.mocklog, { DRY_RUN: "true", BINANCE_SQUARE_OPENAPI_KEY: "" });
  check("6 dry run: previews, publishes nothing, pushes nothing", r.code === 0 && posts(w).length === 0 && sh(w.bare, "rev-parse", "main") === before && /News post preview/.test(r.out), r.out.slice(-500));
}

});
