// test/news-opinion.test.mjs — the v11 news-pipeline upgrades, driven by the
// production bugs and the user's feedback in the notes:
//   1. duplicate detection normalisation ("$201 million" vs "$201M",
//      "Solana" vs "SOL") — the SkyAI pair that scored 0.40 vs 0.45;
//   2. ETF-flow pacing (one flows story per coin per 10h; skipped drafts
//      don't block, pending ones do);
//   3. the opinion structure: opinion is rejected in CONTEXT, allowed in
//      REACTION when (and only when) it stays attributed;
//   4. DETAIL line grounding (the text post must add something the card
//      doesn't have);
//   5. rotating disclaimers.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  sameStory, classifyEtfFlow, etfFlowBlock, recordClaim, emptyNewsState, normalizeNewsState,
  validateNewsCopy, validateReaction, parseNewsAiOutput, assembleNewsPost,
  resolveNewsDisclaimer, pickNewsDisclaimer, NEWS_DISCLAIMER_VARIANTS, titleTokens,
} from "../news.mjs";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const mkState = (entries) => normalizeNewsState({ posted: entries });

describe("duplicate normalisation (the SkyAI $201M bug)", () => {
  const A = "SkyAI sells off entire Solana treasury after $201 million buyback";
  const B = "Solana treasury firm SkyAI sells all SOL holdings after $201M buyback";

  test("the exact pair from the production log now merges", () => {
    assert.equal(sameStory(A, B), true);
  });

  test("coin name vs ticker equivalence is what fixed the token gap", () => {
    const t1 = titleTokens(A), t2 = titleTokens(B);
    assert.ok(t1.has("sol") && t2.has("sol"), "both must carry the canonical symbol token");
  });

  test("unit spelling is normalised but amounts still separate stories", () => {
    assert.equal(sameStory("Fund raises $201M for Solana treasury", "Fund raises $201 million for Solana treasury"), true);
    assert.equal(sameStory("Fund raises $201M for Solana treasury", "Fund raises $7M for Solana treasury"), false);
  });

  test("different coins are still never merged", () => {
    assert.equal(sameStory("Bitcoin ETF sees $500M inflows", "Ethereum ETF sees $500M inflows"), false);
  });
});

describe("ETF-flow pacing (the $527M / $665M bug)", () => {
  test("classification: single-coin flow stories only", () => {
    assert.equal(classifyEtfFlow("US Bitcoin ETFs draw $527M in inflows"), "BTC");
    assert.equal(classifyEtfFlow("BlackRock's IBIT draws $665M as Bitcoin ETF flows accelerate"), "BTC");
    assert.equal(classifyEtfFlow("Bitcoin and Ethereum ETFs see inflows"), null, "two coins = unattributable");
    assert.equal(classifyEtfFlow("SEC approves Bitcoin ETF"), null, "not a flows story");
    assert.equal(classifyEtfFlow("Solana treasury raises $201M"), null, "no ETF, no flows words");
  });

  test("a posted flow story blocks the same coin for 10 hours", () => {
    const state = mkState([{ title: "US Bitcoin ETFs draw $527M", at: NOW - 4 * 3600 * 1000, status: "posted", etfFlow: "BTC" }]);
    const cluster = { primary: { title: "BlackRock's IBIT draws $665M as Bitcoin ETF flows accelerate" } };
    const block = etfFlowBlock(state, cluster, NOW, 10);
    assert.match(block, /paced to one per 10h/);
  });

  test("a skipped draft does NOT block, a pending one does", () => {
    const cluster = { primary: { title: "US Ethereum ETFs see $100M net flows" } };
    const skipped = mkState([{ title: "Ethereum ETF flows dip", at: NOW - 3600 * 1000, status: "skipped", etfFlow: "ETH" }]);
    assert.equal(etfFlowBlock(skipped, cluster, NOW, 10), null, "skipped must not silence tomorrow's flows");
    const pending = mkState([{ title: "Ethereum ETF flows dip", at: NOW - 3600 * 1000, status: "pending", etfFlow: "ETH" }]);
    assert.match(etfFlowBlock(pending, cluster, NOW, 10), /paced/);
  });

  test("different coin, or older than the window: no block", () => {
    const cluster = { primary: { title: "US Ethereum ETFs see $100M net flows" } };
    const btcState = mkState([{ title: "US Bitcoin ETFs draw $527M", at: NOW - 3600 * 1000, status: "posted", etfFlow: "BTC" }]);
    assert.equal(etfFlowBlock(btcState, cluster, NOW, 10), null);
    const oldState = mkState([{ title: "US Ethereum ETFs see $90M net flows", at: NOW - 11 * 3600 * 1000, status: "posted", etfFlow: "ETH" }]);
    assert.equal(etfFlowBlock(oldState, cluster, NOW, 10), null);
  });

  test("recordClaim tags the entry with the flow coin", () => {
    const story = { primary: { title: "US Bitcoin ETFs draw $527M", link: "https://x", source: "CoinDesk" } };
    const state = recordClaim(emptyNewsState(), story, NOW, "posted", { etfFlow: "BTC" });
    assert.equal(state.posted[0].etfFlow, "BTC");
    // and without the tag (regular story) nothing extra is stored
    const plain = recordClaim(emptyNewsState(), { primary: { title: "Other news", link: "", source: "S" } }, NOW, "posted", null);
    assert.ok(!("etfFlow" in plain.posted[0]));
  });
});

describe("opinions: rejected in CONTEXT, owned in REACTION", () => {
  const SRC = "Solana treasury firm SkyAI sells all SOL holdings after $201M buyback. Min Jung of Presto Labs suggested investors may prepare for a potential catch-up trade. The firm sold its remaining SOL over two days, according to the report.";

  test("the exact 'Min Jung suggests...' line from the log is rejected as CONTEXT", () => {
    const r = validateNewsCopy(
      { headline: "SkyAI sells entire Solana treasury after $201 million buyback", context: "Min Jung suggests investors may prepare for a potential catch-up trade." },
      SRC
    );
    assert.match(r.reason, /opinion/);
  });

  test("the same view passes in REACTION when attributed to the person who said it", () => {
    const r = validateNewsCopy(
      {
        headline: "SkyAI sells entire Solana treasury after $201 million buyback",
        context: "The firm sold its remaining SOL over two days.",
        reaction: "Min Jung of Presto Labs sees a potential catch-up trade.",
      },
      SRC
    );
    assert.deepEqual(r, { ok: true });
  });

  test("REACTION rules", () => {
    const ok = (reaction, src = SRC) => validateReaction(reaction, src).ok;
    // attribution verb required
    assert.match(validateReaction("A catch-up trade could be coming for SOL.", SRC).reason, /without attributing/);
    // no first person ("US" the country is not the pronoun "us")
    assert.match(validateReaction("We think a catch-up trade is coming, Presto said.", SRC).reason, /must not speak for the account/);
    // unnamed "analysts"
    assert.match(validateReaction("Analysts see a catch-up trade forming.", SRC).reason, /named firm/);
    // named-firm forms pass
    assert.equal(ok("Analysts at Presto Labs see a potential catch-up trade."), true);
    assert.equal(ok("Presto analysts see a potential catch-up trade."), true);
    // "US" is not the pronoun "us" (and the ETF mention must be in the source)
    const ETF_SRC = "US Bitcoin ETFs draw $527M in inflows. BlackRock said US flows accelerated this week.";
    assert.equal(ok("BlackRock said US ETF flows accelerated.", ETF_SRC), true);
  });

  test("REACTION grounding: invented numbers and names rejected", () => {
    assert.match(validateReaction("Min Jung of Presto Labs sees SOL rising to $500.", SRC).reason, /not in the source story/);
    assert.match(validateReaction("Jan Front of Unknown Capital sees a catch-up trade.", SRC).reason, /names not in the source/);
  });

  test("DETAIL line is grounded like every other line", () => {
    const good = validateNewsCopy(
      { headline: "SkyAI sells entire Solana treasury after $201 million buyback", detail: "The firm sold its remaining SOL over two days." },
      SRC
    );
    assert.deepEqual(good, { ok: true });
    const bad = validateNewsCopy(
      { headline: "SkyAI sells entire Solana treasury after $201 million buyback", detail: "The firm sold its remaining SOL over 21 days." },
      SRC
    );
    assert.match(bad.reason, /not in the source story/);
  });
});

describe("assembly and disclaimers", () => {
  test("text post carries detail then reaction — not a repeat of the card", () => {
    const text = assembleNewsPost({
      headline: "SkyAI sells entire Solana treasury after $201 million buyback",
      context: "The firm sold its remaining SOL over two days.",
      detail: "On-chain data showed the wallets emptied across two days, according to the report.",
      reaction: "Min Jung of Presto Labs sees a potential catch-up trade.",
      sources: ["The Block", "Cointelegraph"],
      score: 55,
      ageMinutes: 30,
      disclaimer: "Not financial advice.",
    });
    const lines = text.split("\n");
    assert.match(lines[0], /^⚡ JUST IN:/);
    assert.match(text, /On-chain data showed/);
    assert.ok(text.indexOf("On-chain data showed") < text.indexOf("Min Jung of Presto Labs"), "detail before reaction");
    assert.match(text, /Sources: The Block, Cointelegraph/);
  });

  test("resolveNewsDisclaimer keeps custom text fixed; pickNewsDisclaimer rotates", () => {
    assert.equal(resolveNewsDisclaimer("off"), "");
    assert.equal(resolveNewsDisclaimer(""), "Not financial advice.");
    assert.equal(resolveNewsDisclaimer("  Your custom line. "), "Your custom line.");
    assert.equal(pickNewsDisclaimer(0), NEWS_DISCLAIMER_VARIANTS[0]);
    assert.equal(pickNewsDisclaimer(1), NEWS_DISCLAIMER_VARIANTS[1]);
    const n = NEWS_DISCLAIMER_VARIANTS.length;
    assert.equal(pickNewsDisclaimer(n), NEWS_DISCLAIMER_VARIANTS[0], "wraps");
    assert.equal(pickNewsDisclaimer(-1), NEWS_DISCLAIMER_VARIANTS[1], "negative seeds are fine");
    assert.ok(NEWS_DISCLAIMER_VARIANTS.every((v) => /not financial advice/i.test(v)), "every variant says it plainly");
    assert.ok(!NEWS_DISCLAIMER_VARIANTS.some((v) => /reporting only|trading advice/i.test(v)), "the retired 'Reporting only' line stays gone");
  });
});
