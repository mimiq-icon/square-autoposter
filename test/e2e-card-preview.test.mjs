// test/e2e-card-preview.test.mjs — v11.3. The REAL post.mjs as a child process (git remote + mocked network),
// with the PNG renderer available (node_modules symlinked into each clone). Proves:
//   * the card is shown in Telegram BEFORE the approval buttons;
//   * a rejected draft uploads NOTHING to Square (no image quota wasted);
//   * an approved one uploads once and posts text + image;
//   * dry runs write a PNG you can open; research can be dry-run per topic.
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
const hasRenderer = fs.existsSync(path.join(ROOT, "node_modules", "@resvg", "resvg-js"));
const skip = !hasGit || !hasRenderer;
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const check = (name, cond, extra = "") => assert.ok(cond, `${name}${extra ? "\n" + extra : ""}`);
const MODULES = ["post.mjs", "news.mjs", "news-sync.mjs", "telegram.mjs", "cards.mjs", "research.mjs", "alerts.mjs", "article.mjs", "style.mjs"];

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "e2ec-"));
  const bare = path.join(root, "remote.git");
  sh(root, "init", "-q", "--bare", "-b", "main", bare);
  const seed = path.join(root, "seed");
  sh(root, "clone", "-q", bare, seed);
  for (const f of MODULES) fs.copyFileSync(path.join(ROOT, f), path.join(seed, f));
  fs.mkdirSync(path.join(seed, "news-state"));
  fs.writeFileSync(path.join(seed, "news-state/posted.json"), '{"posted":[]}\n');
  const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
  sh(seed, ...id, "add", "-A"); sh(seed, ...id, "commit", "-q", "-m", "seed"); sh(seed, "branch", "-M", "main"); sh(seed, "push", "-q", "origin", "main");
  const clone = (n) => { const d = path.join(root, n); sh(root, "clone", "-q", bare, d); fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(d, "node_modules"), "junction"); return d; };
  return { root, clone, mocklog: path.join(root, "mock.log") };
}
function run(cwd, mocklog, mode, extra = {}) {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, HOME: os.homedir(), RUN_MODE: mode, ...(mode === "alerts" ? { MOCK_BTC: "82700" } : {}), BINANCE_SQUARE_OPENAPI_KEY: "x", GROQ_API_KEY: "x", NEWS_GIT_SYNC: "true", NEWS_MIN_GAP_MIN: "0", MOCK_LOG: mocklog, TELEGRAM_BOT_TOKEN: "T", TELEGRAM_CHAT_ID: "111", ...extra };
    const p = spawn(process.execPath, ["--import", MOCK, "post.mjs"], { cwd, env });
    let out = ""; p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => resolve({ code, out }));
  });
}
const logLines = (w) => (fs.existsSync(w.mocklog) ? fs.readFileSync(w.mocklog, "utf8").split("\n").filter(Boolean) : []);
const count = (w, prefix) => logLines(w).filter((l) => l.startsWith(prefix)).length;
const posts = (w) => count(w, "SQUARE ");
const before = (w, a, b) => { const L = logLines(w); const ia = L.findIndex((l) => l.startsWith(a)), ib = L.findIndex((l) => l.startsWith(b)); return ia >= 0 && ib >= 0 && ia < ib; };

const EXTREME = { MOCK_BTC_CHG: "-9", MOCK_BTC_START: "82950", MOCK_AI_TEXT: "HEADLINE: Bitcoin drops below $83,000 and now trades at $82,700\nCONTEXT: It is down 9.0% over the past 24 hours." };

test("news: card preview reaches Telegram BEFORE the approval; approve uploads once and posts text + image", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "news", { NEWS_APPROVAL: "all", MOCK_TG: "approve" });
  check("exit 0", r.code === 0, r.out.slice(-800));
  check("photo preview sent, then approval buttons", count(w, "telegram photo") === 1 && before(w, "telegram photo", "telegram sent"), logLines(w).join("\n") + "\n" + r.out.slice(-600));
  check("one image upload and one post with the image", count(w, "IMAGE-UPLOAD") === 1 && posts(w) === 1 && count(w, "IMAGELIST") === 1, logLines(w).join("\n"));
});

test("news: if BOTH price sources fail the card is still made (just without price chips)", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "news", { NEWS_APPROVAL: "all", MOCK_TG: "approve", MOCK_BINANCE: "fail" });
  check("exit 0; card previewed, uploaded and posted anyway", r.code === 0 && count(w, "telegram photo") === 1 && count(w, "IMAGE-UPLOAD") === 1 && posts(w) === 1, logLines(w).join("\n") + r.out.slice(-700));
  check("the log says the chips were skipped", /price chips unavailable/.test(r.out), r.out.slice(-700));
});

test("news: a REJECTED draft uploads nothing and posts nothing (but you still saw the card)", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "news", { NEWS_APPROVAL: "all", MOCK_TG: "reject" });
  check("exit 0", r.code === 0, r.out.slice(-600));
  check("card previewed", count(w, "telegram photo") === 1, r.out.slice(-600));
  check("no upload, no post", count(w, "IMAGE-UPLOAD") === 0 && posts(w) === 0, logLines(w).join("\n"));
});

test("news: dry run writes the card PNG and sends nothing anywhere", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "news", { NEWS_APPROVAL: "all", DRY_RUN: "true" });
  check("exit 0", r.code === 0, r.out.slice(-600));
  const pngs = fs.existsSync(path.join(pc, "logs")) ? fs.readdirSync(path.join(pc, "logs")).filter((f) => /^card-preview-.*\.png$/.test(f)) : [];
  check("a PNG preview exists and starts with the PNG signature", pngs.length === 1 && fs.readFileSync(path.join(pc, "logs", pngs[0])).subarray(1, 4).toString() === "PNG", String(pngs));
  check("nothing posted/uploaded/sent", posts(w) === 0 && count(w, "IMAGE-UPLOAD") === 0 && count(w, "telegram") === 0, logLines(w).join("\n"));
});

test("alerts: an EXTREME move is previewed in Telegram first; reject uploads nothing, approve posts with the image", { skip, timeout: 180000 }, async () => {
  let w = world(); let pc = w.clone("pc");
  let r = await run(pc, w.mocklog, "alerts", { ...EXTREME, ALERT_APPROVAL: "all", MOCK_TG: "reject" });
  check("reject: exit 0, previewed, no upload, no post", r.code === 0 && count(w, "telegram photo") === 1 && count(w, "IMAGE-UPLOAD") === 0 && posts(w) === 0, logLines(w).join("\n") + r.out.slice(-500));
  w = world(); pc = w.clone("pc");
  r = await run(pc, w.mocklog, "alerts", { ...EXTREME, ALERT_APPROVAL: "all", MOCK_TG: "approve" });
  check("approve: photo before buttons, one upload, one post with image", r.code === 0 && before(w, "telegram photo", "telegram sent") && count(w, "IMAGE-UPLOAD") === 1 && posts(w) === 1 && count(w, "IMAGELIST") === 1, logLines(w).join("\n") + r.out.slice(-500));
});

test("alerts: an ordinary alert has no card, so nothing is previewed or uploaded; the footer never says 'Binance'", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "alerts", { MOCK_AI_TEXT: "HEADLINE: Bitcoin drops below $83,000 and now trades at $82,700\nCONTEXT: It is down 1.2% over the past 24 hours.", ALERT_APPROVAL: "all", MOCK_TG: "approve" });
  check("text-only", r.code === 0 && count(w, "telegram photo") === 0 && count(w, "IMAGE-UPLOAD") === 0 && posts(w) === 1, logLines(w).join("\n") + r.out.slice(-400));
  // and the card builders really leave the tag off:
  const { buildExtremeAlertCardSvg, buildAlertCardSvg } = await import("../cards.mjs");
  const a = buildExtremeAlertCardSvg({ symbol: "$BTC", price: 79450, heroPct: -8.6, headline: "Bitcoin plunges", source: "" });
  const b = buildAlertCardSvg({ symbol: "$BTC", price: 79450, change24h: -2, low: 78000, high: 81000, headline: "Bitcoin dips", source: "" });
  check("no 'Binance' text on either alert card", !/Binance/.test(a) && !/Binance/.test(b));
});

test("research: dry-run one chosen topic -> PNG preview written; unknown topic -> clear message listing ids", { skip, timeout: 180000 }, async () => {
  const COPY = "HOOK: What a stablecoin is, in plain words\nBODY: A stablecoin is a type of cryptocurrency designed to keep a steady value relative to a reference asset such as the US dollar.\nTAKEAWAY: Stablecoins aim to hold a steady price.\nQUESTION: Which part of a stablecoin would you check first?";
  let w = world(); let pc = w.clone("pc");
  let r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_FORCE: "true", RESEARCH_TOPIC: "what-are-stablecoins", MOCK_AI_TEXT: COPY });
  check("exit 0 and a preview PNG", r.code === 0 && fs.existsSync(path.join(pc, "logs")) && fs.readdirSync(path.join(pc, "logs")).some((f) => /^card-preview-research-.*\.png$/.test(f)), r.out.slice(-900));
  check("nothing posted or sent", posts(w) === 0 && count(w, "telegram") === 0, logLines(w).join("\n"));
  w = world(); pc = w.clone("pc");
  r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_TOPIC: "nope" });
  check("unknown topic names the valid ones", r.code === 0 && /Unknown RESEARCH_TOPIC "nope"/.test(r.out) && /what-are-stablecoins/.test(r.out), r.out.slice(-500));
});

test("research: live with Telegram: slide previewed first; reject uploads nothing", { skip, timeout: 180000 }, async () => {
  const COPY = "HOOK: What a stablecoin is, in plain words\nBODY: A stablecoin is a type of cryptocurrency designed to keep a steady value relative to a reference asset such as the US dollar.\nTAKEAWAY: Stablecoins aim to hold a steady price.\nQUESTION: Which part of a stablecoin would you check first?";
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "research", { RESEARCH_FORCE: "true", RESEARCH_TOPIC: "what-are-stablecoins", MOCK_AI_TEXT: COPY, MOCK_TG: "reject", RESEARCH_APPROVAL_WAIT_MIN: "1" });
  check("exit 0; the slide went to Telegram before the buttons; nothing posted", r.code === 0 && before(w, "telegram photo", "telegram sent") && posts(w) === 0, logLines(w).join("\n") + r.out.slice(-700));
});

// ---------------- v11.6 (Stage 3): research reliability ----------------

const TVL_COPY = "HOOK: What total value locked measures\nBODY: TVL is the total value of assets deposited in a protocol, priced in USD at current market rates. It counts deposits, not trading activity.\nTAKEAWAY: TVL counts deposits and ignores trading activity.";
const previewPng = (pc) => fs.existsSync(path.join(pc, "logs")) && fs.readdirSync(path.join(pc, "logs")).some((f) => /^card-preview-research-.*\.png$/.test(f));

test("research reliability 1: both independent sources answer -> logged, concept notes added, preview made", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_FORCE: "true", RESEARCH_TOPIC: "what-is-tvl", MOCK_AI_TEXT: TVL_COPY });
  check("exit 0 and a preview", r.code === 0 && previewPng(pc), r.out.slice(-900));
  check("each source logged with size and timing", /ok: DefiLlama \(defillama-protocols\): \d+ chars, [\d.]+s/.test(r.out) && /ok: Wikipedia \(Decentralized finance\)/.test(r.out), r.out.slice(-900));
  check("concept notes added to the facts", /notes: concept notes added to the facts/.test(r.out), r.out.slice(-900));
  check("2 of 2 sources, minimum 2", /Sources: 2 of 2 independent sources answered; minimum to post is 2\./.test(r.out), r.out.slice(-900));
});

test("research reliability 2: DefiLlama down -> the reason is logged, 1 of 2 sources is not enough, nothing is made", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_FORCE: "true", RESEARCH_TOPIC: "what-is-tvl", MOCK_AI_TEXT: TVL_COPY, MOCK_LLAMA: "503", RESEARCH_RETRIES: "1" });
  check("exit 0", r.code === 0, r.out.slice(-700));
  check("the failure says why, with the attempts", /FAILED: DefiLlama \(defillama-protocols\): HTTP 503 \(2 attempts, [\d.]+s\)/.test(r.out), r.out.slice(-900));
  check("it retried (two llama calls)", count(w, "llama protocols") === 2, logLines(w).join("\n"));
  check("1 of 2 answered, refuses to post thin", /Sources: 1 of 2 independent sources answered; minimum to post is 2\./.test(r.out) && /Not posting a thinly sourced piece/.test(r.out), r.out.slice(-900));
  check("no preview, nothing posted", !previewPng(pc) && posts(w) === 0, r.out.slice(-500));
});

test("research reliability 3: RESEARCH_MIN_SOURCES=1 lets it run on Wikipedia plus the concept notes", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_FORCE: "true", RESEARCH_TOPIC: "what-is-tvl", MOCK_AI_TEXT: TVL_COPY, MOCK_LLAMA: "503", RESEARCH_RETRIES: "0", RESEARCH_MIN_SOURCES: "1" });
  check("exit 0 and a preview, with the failure still logged", r.code === 0 && previewPng(pc) && /FAILED: DefiLlama/.test(r.out), r.out.slice(-900));
  check("sources line honest: 1 of 2, minimum 1", /Sources: 1 of 2 independent sources answered; minimum to post is 1\./.test(r.out), r.out.slice(-900));
});

test("research reliability 4: a source that answers with garbage is reported as such, not as an empty block", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_FORCE: "true", RESEARCH_TOPIC: "what-is-tvl", MOCK_LLAMA: "empty", MOCK_AI_TEXT: TVL_COPY });
  check("says the format may have changed", /FAILED: DefiLlama \(defillama-protocols\): answered, but no protocols could be read \(the format may have changed\)/.test(r.out), r.out.slice(-900));
  check("and does not post", !previewPng(pc) && posts(w) === 0, r.out.slice(-500));
});

// ---------------- v11.8 (Stage 4a): new sources, ranked-bar charts ----------------

const COPY_STABLE = "HOOK: Where stablecoin supply sits\nBODY: USD-pegged stablecoins in circulation total about $271.80B across 4 tracked coins. USDT is the largest at $187.20B, 68.9% of the total.\nTAKEAWAY: Circulating supply shows adoption, not safety.";
const COPY_HALVING = "HOOK: What the Bitcoin halving does\nBODY: A halving cuts the block subsidy, the new bitcoin paid to the miner of each block, in half. It happens every 210,000 blocks, roughly every four years.\nTAKEAWAY: The chain is at block 940,123, and the next halving is at block 1,050,000.";
const COPY_POOLS = "HOOK: Who mined Bitcoin's blocks this week\nBODY: Over the past week 780 blocks were mined. Foundry USA mined 303 of them, 38.8% of blocks.\nTAKEAWAY: A pool's share of blocks shows who assembled them, not who owns the hardware.";

test("research 4a-1: a data topic attaches a ranked-bar chart of its own numbers", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_FORCE: "true", RESEARCH_TOPIC: "stablecoin-supply", MOCK_AI_TEXT: COPY_STABLE });
  check("exit 0, both sources answered", r.code === 0 && /Sources: 2 of 2 independent sources answered/.test(r.out), r.out.slice(-900));
  check("the stablecoin source was read", /ok: DefiLlama \(defillama-stablecoins\)/.test(r.out) && count(w, "llama stablecoins") === 1, r.out.slice(-900));
  check("visual is the ranked bar chart, and a PNG was written", /Visual: ranked bar chart/.test(r.out) && previewPng(pc), r.out.slice(-900));
  check("the chart's own SVG carries the data", fs.readdirSync(path.join(pc, "logs")).some((f) => /^card-preview-research-.*\.svg$/.test(f) && /USDT/.test(fs.readFileSync(path.join(pc, "logs", f), "utf8")) && /\$187\.20B/.test(fs.readFileSync(path.join(pc, "logs", f), "utf8"))), r.out.slice(-500));
  check("nothing posted", posts(w) === 0, r.out.slice(-300));
});

test("research 4a-2: an education topic still gets the explainer slide, and uses the block height", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_FORCE: "true", RESEARCH_TOPIC: "how-halving-works", MOCK_AI_TEXT: COPY_HALVING });
  check("exit 0 and 2 of 2 sources", r.code === 0 && /Sources: 2 of 2 independent sources answered/.test(r.out), r.out.slice(-900));
  check("explainer slide, not a chart", /Visual: explainer slide/.test(r.out) && previewPng(pc), r.out.slice(-900));
  check("the post text carries the computed block facts", /940,123/.test(r.out) && /1,050,000/.test(r.out), r.out.slice(-900));
});

test("research 4a-3: mining pools chart", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_FORCE: "true", RESEARCH_TOPIC: "who-mines-bitcoin", MOCK_AI_TEXT: COPY_POOLS });
  check("exit 0, ranked bar chart written", r.code === 0 && /Visual: ranked bar chart/.test(r.out) && previewPng(pc), r.out.slice(-900));
  check("pool shares are in the chart", fs.readdirSync(path.join(pc, "logs")).some((f) => /^card-preview-research-.*\.svg$/.test(f) && /Foundry USA/.test(fs.readFileSync(path.join(pc, "logs", f), "utf8")) && /38\.8%/.test(fs.readFileSync(path.join(pc, "logs", f), "utf8"))), r.out.slice(-500));
});

// ---------------- v11.9 (Stage 4b): the weekly short data post ----------------

test("research 4b-1: RESEARCH_MODE=data makes a SHORT chart post from a research topic (not the long article)", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_FORCE: "true", RESEARCH_MODE: "data", RESEARCH_TOPIC: "stablecoin-supply", MOCK_AI_TEXT: COPY_STABLE });
  check("exit 0", r.code === 0, r.out.slice(-900));
  check("header names the data mode", /=== RESEARCH MODE \(data, DRY RUN/.test(r.out), r.out.slice(0, 400));
  check("it is a short post: research-short preview, no article markdown", /--- Research research-short preview/.test(r.out) && !/^## /m.test(r.out), r.out.slice(-1200));
  check("the post text is the three lines, with the data", /\$271\.80B/.test(r.out) && /\$187\.20B/.test(r.out), r.out.slice(-900));
  check("image is the ranked bar chart", /Visual: ranked bar chart/.test(r.out) && previewPng(pc), r.out.slice(-600));
});

test("research 4b-2: without data mode a forced research topic is still the long article (unchanged behaviour)", { skip, timeout: 180000 }, async () => {
  const w = world(); const pc = w.clone("pc");
  const r = await run(pc, w.mocklog, "research", { DRY_RUN: "true", RESEARCH_FORCE: "true", RESEARCH_TOPIC: "stablecoin-supply", MOCK_AI_TEXT: COPY_STABLE });
  check("research-article preview", r.code === 0 && /--- Research research-article preview/.test(r.out), r.out.slice(-900));
});
