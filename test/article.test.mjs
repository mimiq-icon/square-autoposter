// test/article.test.mjs — v10.2: AI-written weekly article support + Telegram helpers.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { buildArticleFacts, buildArticlePrompt, parseArticleOutput, validateArticle, wordCount } from "../article.mjs";
import { validateGroundedProse } from "../news.mjs";
import { splitForTelegram, sendTextChunks, buildAlertApprovalMessage, buildArticleApprovalMessage } from "../telegram.mjs";

const fmt = {
  price: (n) => `$${n.toLocaleString("en-US", { maximumFractionDigits: n >= 100 ? 0 : 2 })}`,
  pct: (n) => `${n >= 0 ? "+" : "-"}${Math.abs(n).toFixed(1)}%`,
  mcap: (n) => `$${(n / 1e12).toFixed(2)}T`,
};
const facts = buildArticleFacts({
  weekRange: "Oct 12 - Oct 18, 2026",
  globalMarket: { totalMcap: 2.74e12, mcapChange24h: -0.5, btcDominance: 60.1, totalVolume: 1.1e11 },
  fng: { value: 59, classification: "Greed" },
  watchlist: [
    { symbol: "BTC", name: "Bitcoin", price: 82950, change24h: -1.2, change7d: 3.4 },
    { symbol: "ETH", name: "Ethereum", price: 3500, change24h: 0.8, change7d: -2.1 },
  ],
  moves: [{ symbol: "SOL", changePct: 6.1 }],
  trending: [{ name: "Pearl" }],
  headlines: [{ title: "Bitcoin and Ether ETFs shed $549M as October ETH outflows near $1B", source: "Cointelegraph" }],
}, fmt);

describe("buildArticleFacts", () => {
  test("contains every section's figures, headlines with publisher", () => {
    for (const s of ["WEEK: Oct 12 - Oct 18, 2026", "$2.74T", "60.1%", "59/100 (Greed)", "Bitcoin (BTC): $82,950; 24h -1.2%; 7-day +3.4%", "SOL: up 6.1% in 24h", "Pearl", "[Cointelegraph]"]) {
      assert.ok(facts.includes(s), s);
    }
  });
  test("omits sections it has no data for", () => {
    const f = buildArticleFacts({ weekRange: "W", watchlist: [] }, fmt);
    assert.doesNotMatch(f, /MARKET:|SENTIMENT:|NEWS THIS WEEK/);
  });
  test("prompt embeds facts and the rules", () => {
    const p = buildArticlePrompt(facts);
    assert.ok(p.includes(facts));
    assert.match(p, /TITLE:/); assert.match(p, /No numbered lists/); assert.match(p, /not financial advice/i);
  });
});

const filler = (n) => Array.from({ length: n }, () => "The data shows a mixed picture across the majors this week.").join(" ");
const goodBody = [
  "## Market snapshot",
  `The total crypto market cap stands at $2.74T, down 0.5% over 24h, while Bitcoin dominance is 60.1%. The Fear & Greed Index reads 59/100 (Greed). ${filler(8)}`,
  "## The majors",
  `Bitcoin trades at $82,950 with a 7-day change of +3.4%. Ethereum is at $3,500 and down 2.1% over 7-day. ${filler(8)}`,
  "## Stories that shaped the week",
  `According to Cointelegraph, Bitcoin and Ether ETFs shed $549M as October ETH outflows near $1B. ${filler(8)}`,
  "## Reading the data",
  `${filler(10)}`,
  "This is not financial advice.",
].join("\n\n");
const goodRaw = `TITLE: Bitcoin holds firm while ETF outflows weigh on Ether\nBODY:\n${goodBody}`;

describe("parseArticleOutput + validateArticle", () => {
  test("parses title and body, strips code fences", () => {
    const a = parseArticleOutput("```markdown\n" + goodRaw + "\n```");
    assert.equal(a.title, "Bitcoin holds firm while ETF outflows weigh on Ether");
    assert.ok(a.body.startsWith("## Market snapshot"));
  });
  test("missing layout => null / rejected", () => {
    assert.equal(parseArticleOutput("just some text"), null);
    assert.equal(validateArticle(null, facts).ok, false);
  });
  test("a faithful article passes", () => {
    const v = validateArticle(parseArticleOutput(goodRaw), facts);
    assert.deepEqual(v, { ok: true }, JSON.stringify(v));
  });
  test("an invented number is rejected", () => {
    const bad = parseArticleOutput(goodRaw.replace("$82,950", "$91,230"));
    const v = validateArticle(bad, facts);
    assert.equal(v.ok, false); assert.match(v.reason, /91230|91,230|not in the source/);
  });
  test("a prediction / advice / cashtag / link / emoji / numbered list each fail", () => {
    const mk = (extra) => parseArticleOutput(goodRaw.replace("## Reading the data", `## Reading the data\n\n${extra}`));
    assert.equal(validateArticle(mk("Bitcoin will surge next week."), facts).ok, false);
    assert.equal(validateArticle(mk("You should buy now."), facts).ok, false);
    assert.equal(validateArticle(mk("Watch $BTC closely."), facts).ok, false);
    assert.equal(validateArticle(mk("See https://example.com for more."), facts).ok, false);
    assert.equal(validateArticle(mk("Strong week 🚀"), facts).ok, false);
    assert.equal(validateArticle(mk("1. First point"), facts).ok, false);
  });
  test("too short, or too few sections, is rejected", () => {
    assert.equal(validateArticle({ title: "A reasonable article title here", body: "## One\n\nShort." }, facts).ok, false);
    assert.equal(validateArticle({ title: "A reasonable article title here", body: filler(60) }, facts).ok, false);
  });
  test("an unknown name is rejected", () => {
    const bad = parseArticleOutput(goodRaw.replace("According to Cointelegraph", "According to Bloomberg analysts at Zorbex Capital"));
    assert.equal(validateArticle(bad, facts).ok, false);
  });
  test("wordCount", () => assert.equal(wordCount("a b  c\nd"), 4));
});

describe("validateGroundedProse markdown handling", () => {
  test("headings and bullets are not mistaken for unknown names", () => {
    const src = "Bitcoin is at $82,950. Solana up 6.1%.";
    const text = "## Market Snapshot\n- Bitcoin is at $82,950.\n- Solana is up 6.1%.";
    assert.deepEqual(validateGroundedProse(text, src), { ok: true });
  });
});

describe("splitForTelegram", () => {
  test("short text is one piece", () => assert.deepEqual(splitForTelegram("hello"), ["hello"]));
  test("long text splits on paragraphs, every piece within the limit, nothing lost", () => {
    const para = "word ".repeat(150).trim();
    const text = Array.from({ length: 12 }, () => para).join("\n\n");
    const parts = splitForTelegram(text, 3500);
    assert.ok(parts.length > 1);
    for (const p of parts) assert.ok(p.length <= 3500);
    assert.equal(parts.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
  });
  test("a single huge unbroken string is still cut", () => {
    const parts = splitForTelegram("x".repeat(9000), 3500);
    assert.deepEqual(parts.map((p) => p.length), [3500, 3500, 2000]);
  });
});

describe("sendTextChunks", () => {
  test("posts each chunk as plain text to the right chat", async () => {
    const sent = [];
    const fetchFn = async (url, opts) => { sent.push({ url, body: JSON.parse(opts.body) }); return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }); };
    const n = await sendTextChunks({ token: "T", chatId: 42, text: "a\n\n".repeat(2000), fetchFn });
    assert.equal(n, sent.length); assert.ok(n >= 2);
    assert.match(sent[0].url, /bot T?|botT\/sendMessage/);
    assert.equal(sent[0].body.chat_id, "42");
    assert.equal("parse_mode" in sent[0].body, false);
  });
  test("a Telegram error throws with its description", async () => {
    const fetchFn = async () => new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 });
    await assert.rejects(sendTextChunks({ token: "T", chatId: 1, text: "hi", fetchFn }), /chat not found/);
  });
});

describe("approval messages", () => {
  test("alert message escapes HTML and names the author", () => {
    const m = buildAlertApprovalMessage({ text: "A <b> & B", alert: { name: "Bitcoin", kind: "level", score: 55 }, provider: "groq" });
    assert.match(m, /A &lt;b&gt; &amp; B/); assert.match(m, /Written by: groq/);
  });
  test("article message shows title and word count", () => {
    const m = buildArticleApprovalMessage({ title: "T & Co", words: 512, provider: null });
    assert.match(m, /T &amp; Co/); assert.match(m, /512 words/); assert.match(m, /data template/);
  });
});
