// test/post.test.mjs
// ============================================================================
// Unit tests for the pure, no-network logic in post.mjs: formatting,
// template builders, and the isSafeAiText() compliance gate.
//
// Deliberately NOT covered here: getMarketData/getTrendingCoins/etc. (real
// network calls), squareApi/postToSquare (real Binance API calls), and the
// AI provider calls (real LLM API calls). Those need an integration-test
// layer with mocked HTTP, which this project doesn't have yet — this suite
// is scoped to what can be tested honestly without a network.
//
// Run with: node --test
// (Node 18+ built-in test runner — no npm install, consistent with the
// project's own "no npm install needed" philosophy.)
// ============================================================================

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  fmtPct,
  fmtPrice,
  fmtMcap,
  rotateSubset,
  coingeckoHeaders,
  countCashtags,
  findUngroundedCoinName,
  isSafeAiText,
  enforceMaxLength,
  buildSnapshotPost,
  buildTopMoverPost,
  buildEducationalPost,
  buildWeeklyRecapPost,
  buildMacroOverviewPost,
  buildAnomalyRadarPost,
  buildTrendingTodayPost,
  buildMarketSentimentPost,
  // v6: new draft/publish functions
  buildWeeklyArticleDraft,
  formatArticleForIssue,
  parseArticleFromIssue,
} from "../post.mjs";

// ---------------------------------------------------------------------------
// Fixtures — small, realistic coin objects matching getMarketData()'s shape.
// ---------------------------------------------------------------------------
function coin(overrides = {}) {
  return {
    symbol: "BTC",
    price: 67234.5,
    change24h: 1.23,
    change7d: -2.5,
    volume24h: 4.5e10,
    marketCap: 1.3e12,
    rank: 1,
    high24h: 68000,
    low24h: 66000,
    athChangePct: -12.4,
    ...overrides,
  };
}

const FIVE_COINS = ["BTC", "ETH", "BNB", "SOL", "XRP"].map((symbol, i) =>
  coin({ symbol, price: 100 * (i + 1), change24h: i % 2 === 0 ? 2.1 : -1.4 })
);

// ---------------------------------------------------------------------------
describe("formatting helpers", () => {
  test("fmtPct adds a leading + for non-negative numbers", () => {
    assert.equal(fmtPct(1.234), "+1.23%");
    assert.equal(fmtPct(0), "+0.00%");
    assert.equal(fmtPct(-0.634), "-0.63%");
  });

  test("fmtPct handles null/undefined", () => {
    assert.equal(fmtPct(null), "n/a");
    assert.equal(fmtPct(undefined), "n/a");
  });

  test("fmtPrice always shows at least 2 decimals, even for sub-$10 prices", () => {
    // This is the v5 bug fix mentioned in the source: toLocaleString was
    // silently dropping trailing zeros for prices under $10.
    assert.equal(fmtPrice(7.9), "$7.90");
    assert.equal(fmtPrice(63199), "$63,199.00");
  });

  test("fmtPrice allows up to 4 decimals for sub-$10 prices", () => {
    assert.equal(fmtPrice(0.1234), "$0.1234");
  });

  test("fmtMcap scales to B/T and falls back to raw for small numbers", () => {
    assert.equal(fmtMcap(2.28e12), "$2.28T");
    assert.equal(fmtMcap(4.5e9), "$4.50B");
    assert.equal(fmtMcap(500), "$500");
    assert.equal(fmtMcap(null), "n/a");
  });

  test("rotateSubset wraps around the list instead of running off the end", () => {
    const list = ["a", "b", "c"];
    assert.deepEqual(rotateSubset(list, 2, 2), ["c", "a"]);
    assert.deepEqual(rotateSubset(list, 3, 5), ["c", "a", "b"]);
  });

  test("rotateSubset never returns more items than the list has", () => {
    assert.equal(rotateSubset(["a", "b"], 5, 0).length, 2);
  });
});

// ---------------------------------------------------------------------------
describe("coingeckoHeaders", () => {
  test("returns an empty object when COINGECKO_API_KEY is not set", () => {
    delete process.env.COINGECKO_API_KEY;
    assert.deepEqual(coingeckoHeaders(), {});
  });

  test("returns the demo-key header when COINGECKO_API_KEY is set", () => {
    process.env.COINGECKO_API_KEY = "test-key-123";
    assert.deepEqual(coingeckoHeaders(), { "x-cg-demo-api-key": "test-key-123" });
    delete process.env.COINGECKO_API_KEY; // clean up for other tests
  });
});

// ---------------------------------------------------------------------------
describe("countCashtags / findUngroundedCoinName", () => {
  test("countCashtags finds all $TICKER matches", () => {
    assert.deepEqual(countCashtags("$BTC is up, $ETH is down"), ["$BTC", "$ETH"]);
  });

  test("countCashtags returns an empty array when there are none", () => {
    assert.deepEqual(countCashtags("no tickers here"), []);
  });

  test("findUngroundedCoinName catches a bare coin name not in today's data", () => {
    const result = findUngroundedCoinName("Bitcoin and Ethereum both moved today", ["ETH"]);
    assert.deepEqual(result, { symbol: "BTC", name: "bitcoin" });
  });

  test("findUngroundedCoinName allows a name whose symbol IS in allowedSymbols", () => {
    const result = findUngroundedCoinName("Bitcoin moved today", ["BTC"]);
    assert.equal(result, null);
  });

  test("findUngroundedCoinName returns null when no known coin names appear", () => {
    assert.equal(findUngroundedCoinName("The market moved sideways today", ["BTC"]), null);
  });
});

// ---------------------------------------------------------------------------
describe("isSafeAiText — the compliance gate", () => {
  const ALLOWED = ["BTC", "ETH"];
  const GOOD = "$BTC is holding near $67,234 while $ETH climbs 1.2% today. Which one are you watching? Not financial advice. DYOR.";

  test("accepts a well-formed post", () => {
    assert.deepEqual(isSafeAiText(GOOD, ALLOWED), { ok: true });
  });

  test("rejects empty or non-string input", () => {
    assert.equal(isSafeAiText("", ALLOWED).ok, false);
    assert.equal(isSafeAiText(null, ALLOWED).ok, false);
  });

  test("rejects text under 100 chars, not retryable", () => {
    const r = isSafeAiText("$BTC up today. DYOR.", ALLOWED);
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false);
    assert.match(r.reason, /too short/);
  });

  test("rejects text over 600 chars, not retryable", () => {
    const r = isSafeAiText("$BTC ".repeat(200) + "DYOR.", ALLOWED);
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false);
    assert.match(r.reason, /too long/);
  });

  test("rejects zero cashtags, retryable", () => {
    const r = isSafeAiText(
      "The market moved today in an interesting way overall, drifting sideways without any single asset really taking the lead all session.",
      ALLOWED
    );
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true);
    assert.match(r.reason, /no cashtags/);
  });

  test("rejects a cashtag not in today's allowed data, retryable", () => {
    const r = isSafeAiText(
      "$DOGE is having a big day compared to everything else across the broader market today, moving more than most other assets around it. DYOR.",
      ALLOWED
    );
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true);
    assert.match(r.reason, /not in today's data/);
  });

  test("rejects more unique coins than MAX_CASHTAGS_PER_POST, retryable", () => {
    const text = "$BTC $ETH $SOL $XRP are all over the place today, each moving in a slightly different direction from the others right now. DYOR.";
    const r = isSafeAiText(text, ["BTC", "ETH", "SOL", "XRP"]);
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true);
    assert.match(r.reason, /max is/);
  });

  test("rejects an ungrounded bare coin name, retryable", () => {
    const r = isSafeAiText(
      "$ETH is up today while Bitcoin drifts sideways in the background of an otherwise quiet trading session. DYOR.",
      ["ETH"]
    );
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true);
    assert.match(r.reason, /isn't in today's data/);
  });

  test("rejects missing DYOR / not-financial-advice line, not retryable", () => {
    const r = isSafeAiText(
      "$BTC is up today and $ETH is climbing too, both moving nicely this week with steady gains across the board for each asset.",
      ALLOWED
    );
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false);
    assert.match(r.reason, /DYOR/);
  });

  test("rejects a known filler phrase, not retryable", () => {
    const r = isSafeAiText(
      "$BTC is making waves today while $ETH holds steady near its recent trading range from earlier this week. DYOR.",
      ALLOWED
    );
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false);
    assert.match(r.reason, /filler phrase/);
  });

  test("rejects a volume/market-cap size comparison between coins, not retryable", () => {
    const r = isSafeAiText(
      "$BTC has a bigger market cap than $ETH right now, even though both assets have moved in a similar direction across the week. DYOR.",
      ALLOWED
    );
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false);
    assert.match(r.reason, /size comparison/);
  });

  test("rejects a banned trade-nudge phrase, not retryable", () => {
    const r = isSafeAiText(
      "$BTC looks like a good entry point for anyone watching the market closely today, based on how the session has gone so far. DYOR.",
      ALLOWED
    );
    assert.equal(r.ok, false);
    assert.equal(r.retryable, false);
    assert.match(r.reason, /banned phrase/);
  });

  test("accepts any of the rotated disclaimer variants", () => {
    const variants = [
      "Not financial advice. DYOR.",
      "NFA. Always DYOR.",
      "Not financial advice — do your own research.",
    ];
    for (const variant of variants) {
      const text = `$BTC is holding steady near $67,234 while $ETH climbs roughly 1.2% higher across an otherwise quiet session today. ${variant}`;
      assert.equal(isSafeAiText(text, ALLOWED).ok, true, `variant failed: "${variant}"`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("enforceMaxLength", () => {
  test("passes short text through unchanged", () => {
    const text = "Short post. DYOR.";
    assert.equal(enforceMaxLength(text), text);
  });

  test("trims long text but keeps the first line and the closing lines", () => {
    const lines = ["HOOK LINE", ...Array(100).fill("filler middle line that takes up space"), "", "Not financial advice. DYOR."];
    const long = lines.join("\n");
    const result = enforceMaxLength(long);
    assert.ok(result.length <= 1500, `expected <= 1500 chars, got ${result.length}`);
    assert.ok(result.startsWith("HOOK LINE"), "should keep the opening hook");
    assert.ok(result.endsWith("Not financial advice. DYOR."), "should keep the closing disclaimer");
  });
});

// ---------------------------------------------------------------------------
describe("template builders return valid, non-empty posts", () => {
  test("buildSnapshotPost includes cashtags for the featured coins", () => {
    const text = buildSnapshotPost(FIVE_COINS, 0);
    assert.match(text, /\$BTC/);
    assert.doesNotMatch(text, /\$COIN\d/); // no leftover placeholders
  });

  test("buildTopMoverPost picks the coin with the largest absolute 24h move", () => {
    const data = [coin({ symbol: "BTC", change24h: 1.0 }), coin({ symbol: "ETH", change24h: -9.5 })];
    const text = buildTopMoverPost(data);
    assert.match(text, /\$ETH/);
  });

  test("buildTopMoverPost returns null for empty data", () => {
    assert.equal(buildTopMoverPost([]), null);
  });

  test("buildEducationalPost rotates tips by dayIndex without throwing", () => {
    for (let day = 0; day < 10; day++) {
      const text = buildEducationalPost(FIVE_COINS, day);
      assert.ok(text.length > 0);
    }
  });

  test("buildWeeklyRecapPost includes the 7d change, not 24h", () => {
    const text = buildWeeklyRecapPost(FIVE_COINS, 0);
    assert.match(text, /this week/);
  });

  test("buildMacroOverviewPost includes total market cap and BTC dominance", () => {
    const globalMarket = { totalMcap: 2.28e12, totalVolume: 9e10, btcDominance: 55.8, mcapChange24h: -0.4 };
    const text = buildMacroOverviewPost(FIVE_COINS, 0, globalMarket, { classification: "Fear", value: 27 });
    assert.match(text, /Total cap/);
    assert.match(text, /BTC dominance/);
  });

  test("buildAnomalyRadarPost returns null when there are no anomalies", () => {
    assert.equal(buildAnomalyRadarPost([]), null);
    assert.equal(buildAnomalyRadarPost(null), null);
  });

  test("buildAnomalyRadarPost caps at MAX_CASHTAGS_PER_POST entries", () => {
    const anomalies = ["BTC", "ETH", "SOL", "XRP", "ADA"].map((symbol) => ({ symbol, changePct: 15, volume: 1e9 }));
    const text = buildAnomalyRadarPost(anomalies);
    const tagCount = (text.match(/\$[A-Z]+/g) || []).length;
    assert.ok(tagCount <= 3, `expected at most 3 cashtags, got ${tagCount}`);
  });

  test("buildTrendingTodayPost returns null when there's no trending data", () => {
    assert.equal(buildTrendingTodayPost([]), null);
  });

  test("buildMarketSentimentPost returns null outside extreme fear/greed", () => {
    assert.equal(buildMarketSentimentPost({ value: 50, classification: "Neutral" }, FIVE_COINS, 0), null);
  });

  test("buildMarketSentimentPost fires on extreme fear", () => {
    const text = buildMarketSentimentPost({ value: 15, classification: "Extreme Fear" }, FIVE_COINS, 0);
    assert.match(text, /Extreme Fear/);
  });

  test("buildMarketSentimentPost fires on extreme greed", () => {
    const text = buildMarketSentimentPost({ value: 85, classification: "Extreme Greed" }, FIVE_COINS, 0);
    assert.match(text, /Extreme Greed/);
  });
});

// ---------------------------------------------------------------------------
// v6: weekly article draft/publish functions
// ---------------------------------------------------------------------------

describe("buildWeeklyArticleDraft", () => {
  const mockCtx = {
    globalMarket: { totalMcap: 2.28e12, totalVolume: 8.9e10, btcDominance: 55.8, ethDominance: 18.1, mcapChange24h: 1.5 },
    fng: { value: 27, classification: "Fear" },
    anomalies: [{ symbol: "SOL", changePct: 12.3, volume: 4.5e9 }],
    trending: [{ symbol: "SOL", name: "Solana", rank: 5 }],
  };

  test("returns { title, body } object with real content", () => {
    const article = buildWeeklyArticleDraft(FIVE_COINS, 7, mockCtx);
    assert.ok(article, "expected an article object, got null");
    assert.ok(article.title, "title missing");
    assert.ok(article.body, "body missing");
    assert.match(article.title, /Weekly Crypto Recap/);
  });

  test("returns null when data is empty", () => {
    const article = buildWeeklyArticleDraft([], 7, mockCtx);
    assert.equal(article, null);
  });

  test("body includes watchlist coins with cashtags", () => {
    const article = buildWeeklyArticleDraft(FIVE_COINS, 7, mockCtx);
    // rotateSubset(FIVE_COINS, 3, 7) starts at index 7%5=2, so it picks
    // XRP, SOL, BNB — not BTC. Just assert at least one cashtag is present.
    assert.match(article.body, /\$[A-Z]{2,6}/);
  });
});

describe("formatArticleForIssue", () => {
  test("wraps title and body in HTML comment markers", () => {
    const article = { title: "Test Title", body: "Test body content." };
    const formatted = formatArticleForIssue(article);
    assert.match(formatted, /<!-- ARTICLE_TITLE -->/);
    assert.match(formatted, /<!-- ARTICLE_BODY -->/);
    assert.match(formatted, /<!-- END -->/);
    assert.match(formatted, /Test Title/);
    assert.match(formatted, /Test body content\./);
  });

  test("includes edit instructions for the human", () => {
    const article = { title: "T", body: "B" };
    const formatted = formatArticleForIssue(article);
    assert.match(formatted, /Edit the title and body/);
    assert.match(formatted, /close this issue to publish/);
  });

  test("returns null for missing title or body", () => {
    assert.equal(formatArticleForIssue(null), null);
    assert.equal(formatArticleForIssue({ title: "T" }), null);
    assert.equal(formatArticleForIssue({ body: "B" }), null);
    assert.equal(formatArticleForIssue({}), null);
  });
});

describe("parseArticleFromIssue", () => {
  test("round-trips through formatArticleForIssue", () => {
    const original = { title: "Weekly Recap — July 7", body: "## Market Overview\nTotal cap: $2.28T." };
    const formatted = formatArticleForIssue(original);
    const parsed = parseArticleFromIssue(formatted);
    assert.deepEqual(parsed, original);
  });

  test("extracts edited title and body from a realistic Issue body", () => {
    const issueBody = [
      "<!-- ARTICLE_TITLE -->",
      "My Edited Title",
      "<!-- ARTICLE_BODY -->",
      "## My Edited Section",
      "This is my edited content.",
      "<!-- END -->",
      "",
      "---",
      "Edit instructions here...",
    ].join("\n");
    const parsed = parseArticleFromIssue(issueBody);
    assert.equal(parsed.title, "My Edited Title");
    assert.equal(parsed.body, "## My Edited Section\nThis is my edited content.");
  });

  test("returns null when markers are missing", () => {
    assert.equal(parseArticleFromIssue("no markers here"), null);
    assert.equal(parseArticleFromIssue(""), null);
    assert.equal(parseArticleFromIssue(null), null);
  });

  test("returns null when markers exist but content is empty", () => {
    const issueBody = "<!-- ARTICLE_TITLE -->\n\n<!-- ARTICLE_BODY -->\n\n<!-- END -->";
    const parsed = parseArticleFromIssue(issueBody);
    assert.equal(parsed, null);
  });

  test("preserves markdown formatting in body", () => {
    const article = { title: "T", body: "## Header\n\n- bullet 1\n- bullet 2\n\n**bold text**" };
    const formatted = formatArticleForIssue(article);
    const parsed = parseArticleFromIssue(formatted);
    assert.equal(parsed.body, "## Header\n\n- bullet 1\n- bullet 2\n\n**bold text**");
  });
});
