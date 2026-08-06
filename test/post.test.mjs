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
  pickHashtags,
  appendHashtags,
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
  buildTopMoversDigestPost,
  buildMarketSpotlightPost,
  percentEncode,
  buildOAuth1Header,
  buildQuickChartPreviewUrl,
  buildDraftIssueBody,
  parseDraftIssue,
} from "../post.mjs";

// ---------------------------------------------------------------------------
// Fixtures for v9 broad-movers-shaped data (getBroadMarketMovers() output).
// ---------------------------------------------------------------------------
function moverCoin(overrides = {}) {
  return {
    symbol: "XYZ",
    name: "Xyzcoin",
    price: 12.34,
    change24h: 3.5,
    volume24h: 5e7,
    marketCap: 3e8,
    rank: 42,
    athChangePct: -55.2,
    ...overrides,
  };
}

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

  test("fmtPrice does not round sub-cent prices to a misleading $0.00 (v9 fix)", () => {
    // Pre-v9, maximumFractionDigits was capped at 4 for all prices under
    // $10, which rounded meme-coin-tier prices like $0.0000123 down to
    // "$0.00" — a wrong number, not just a display quirk. This matters now
    // that digest/spotlight (v9) pull from the full top-100 market instead
    // of the curated 8-coin watchlist.
    assert.equal(fmtPrice(0.0000123), "$0.0000123");
    assert.equal(fmtPrice(0.0000089), "$0.0000089");
  });

  test("fmtPrice still uses exactly 2 decimals for prices >= $10 (no regression)", () => {
    assert.equal(fmtPrice(63199), "$63,199.00");
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
describe("pickHashtags / appendHashtags", () => {
  test("picks a mapped hashtag for a single grounded cashtag", () => {
    assert.deepEqual(pickHashtags("$BTC is holding steady today. DYOR."), ["#Bitcoin"]);
  });

  test("picks hashtags in order of first appearance, deduped, capped at MAX_HASHTAGS_PER_POST", () => {
    const text = "$ETH leads while $BTC and $ETH again both hold. $BNB lags. DYOR.";
    assert.deepEqual(pickHashtags(text), ["#Ethereum", "#Bitcoin"]);
  });

  test("falls back to the generic hashtag for an unmapped symbol", () => {
    assert.deepEqual(pickHashtags("$PEPE is pumping today. DYOR."), ["#Crypto"]);
  });

  test("falls back to the generic hashtag when there are no cashtags at all", () => {
    assert.deepEqual(pickHashtags("The market moved sideways today. DYOR."), ["#Crypto"]);
  });

  test("never returns more than MAX_HASHTAGS_PER_POST tags even with many unique symbols", () => {
    const text = "$BTC $ETH $BNB $SOL $XRP all moved today. DYOR.";
    assert.ok(pickHashtags(text).length <= 2);
  });

  test("appendHashtags appends to the same line, not a new one", () => {
    const result = appendHashtags("$BTC is holding steady today. Not financial advice. DYOR.");
    assert.equal(result.split("\n").length, 1);
    assert.match(result, /#Bitcoin$/);
  });

  test("appendHashtags is grounded in the text passed in, not a fixed default", () => {
    const btcResult = appendHashtags("$BTC only. DYOR.");
    const ethResult = appendHashtags("$ETH only. DYOR.");
    assert.match(btcResult, /#Bitcoin/);
    assert.match(ethResult, /#Ethereum/);
    assert.doesNotMatch(btcResult, /#Ethereum/);
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

  // v9.4 regression: data[dayIndex % data.length] is data[NaN] when data is
  // empty (dayIndex % 0 === NaN), which used to throw on coin.symbol instead
  // of falling back gracefully like every other template.
  test("buildEducationalPost returns null (not a throw) for empty data", () => {
    assert.equal(buildEducationalPost([], 3), null);
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

  // v9.4 regression: same empty-data crash as buildEducationalPost above,
  // reachable here whenever fng is at an extreme AND data is empty.
  test("buildMarketSentimentPost returns null (not a throw) for empty data at an extreme", () => {
    assert.equal(buildMarketSentimentPost({ value: 15, classification: "Extreme Fear" }, [], 0), null);
  });
});

// ---------------------------------------------------------------------------
// v8: weekly article draft/publish pipeline — the human-in-the-loop gate
// that replaced the old Sunday auto-publish ladder. buildDraftIssueBody /
// parseDraftIssue are two halves of a round trip: one writes a GitHub Issue
// body, the other reads it back (possibly after a human has edited it).
// ---------------------------------------------------------------------------
describe("buildQuickChartPreviewUrl", () => {
  test("returns a GET url embedding the chart config, no network call", () => {
    const url = buildQuickChartPreviewUrl({ type: "line", data: { labels: ["a"], datasets: [] } });
    assert.match(url, /^https:\/\/quickchart\.io\/chart\?c=/);
    const decoded = JSON.parse(decodeURIComponent(url.split("?c=")[1].split("&")[0]));
    assert.equal(decoded.type, "line");
  });
});

describe("buildDraftIssueBody / parseDraftIssue round trip", () => {
  const draftInput = {
    title: "Weekly Crypto Recap — July 7–13, 2026",
    body: "## Market Overview\nTotal crypto market cap: **$2.28T**.\n\n---\n*Weekly recap, not financial advice. Always DYOR.*",
    dayIndex: 7,
    chartPreviewUrl: "https://quickchart.io/chart?c=%7B%7D",
    weekRange: "July 7–13, 2026",
  };

  test("built issue body contains human instructions and the chart preview", () => {
    const issueBody = buildDraftIssueBody(draftInput);
    assert.match(issueBody, /Nothing publishes until you approve it/);
    assert.match(issueBody, /approved-for-posting/);
    assert.match(issueBody, /!\[7-day chart preview\]/);
    assert.match(issueBody, /# Weekly Crypto Recap/);
  });

  test("parseDraftIssue recovers the exact title, body, and dayIndex when unedited", () => {
    const issueBody = buildDraftIssueBody(draftInput);
    const parsed = parseDraftIssue(issueBody);
    assert.equal(parsed.title, draftInput.title);
    assert.equal(parsed.body, draftInput.body);
    assert.equal(parsed.dayIndex, 7);
  });

  test("parseDraftIssue still works after a human edits the title and body text", () => {
    const issueBody = buildDraftIssueBody(draftInput);
    const edited = issueBody
      .replace("# Weekly Crypto Recap — July 7–13, 2026", "# Big Week for Crypto — July 7–13")
      .replace("Total crypto market cap: **$2.28T**.", "Total crypto market cap: **$2.28T**, a new high for the year.");
    const parsed = parseDraftIssue(edited);
    assert.equal(parsed.title, "Big Week for Crypto — July 7–13");
    assert.match(parsed.body, /a new high for the year/);
  });

  test("parseDraftIssue falls back to dayIndex: null if the hidden marker is deleted, but still recovers title/body", () => {
    const issueBody = buildDraftIssueBody(draftInput);
    const edited = issueBody.replace(/<!--\s*day_index:\s*7\s*-->\n/, "");
    const parsed = parseDraftIssue(edited);
    assert.equal(parsed.dayIndex, null);
    assert.equal(parsed.title, draftInput.title);
  });

  test("parseDraftIssue returns null if the title line is deleted entirely", () => {
    const issueBody = buildDraftIssueBody(draftInput);
    const edited = issueBody.replace(`# ${draftInput.title}\n\n`, "");
    assert.equal(parseDraftIssue(edited), null);
  });

  test("parseDraftIssue returns null for unrelated issue bodies (no markers at all)", () => {
    assert.equal(parseDraftIssue("Just a normal issue with no draft markers."), null);
  });

  test("parseDraftIssue returns null for empty/missing input", () => {
    assert.equal(parseDraftIssue(""), null);
    assert.equal(parseDraftIssue(null), null);
  });

  test("buildDraftIssueBody omits the chart preview line when no chart is available", () => {
    const issueBody = buildDraftIssueBody({ ...draftInput, chartPreviewUrl: null });
    assert.doesNotMatch(issueBody, /!\[7-day chart preview\]/);
  });
});

// ---------------------------------------------------------------------------
// v9: buildTopMoversDigestPost — top-100 breadth digest
// ---------------------------------------------------------------------------
describe("buildTopMoversDigestPost", () => {
  test("returns null for empty/missing input", () => {
    assert.equal(buildTopMoversDigestPost([]), null);
    assert.equal(buildTopMoversDigestPost(null), null);
  });

  test("identifies the best gainer and worst loser correctly", () => {
    const movers = [
      moverCoin({ symbol: "AAA", change24h: 12.5 }),
      moverCoin({ symbol: "BBB", change24h: -8.2 }),
      moverCoin({ symbol: "CCC", change24h: 1.1 }),
    ];
    const post = buildTopMoversDigestPost(movers);
    assert.match(post, /\$AAA \+12\.50%/);
    assert.match(post, /\$BBB -8\.20%/);
  });

  test("computes breadth (green count) correctly", () => {
    const movers = [
      moverCoin({ symbol: "AAA", change24h: 5 }),
      moverCoin({ symbol: "BBB", change24h: -5 }),
      moverCoin({ symbol: "CCC", change24h: 0 }),
      moverCoin({ symbol: "DDD", change24h: -1 }),
    ];
    const post = buildTopMoversDigestPost(movers);
    // AAA and CCC are >= 0 -> 2 of 4 green
    assert.match(post, /2\/4 of the top 100 are green today/);
  });

  test("uses only 2 cashtags (gainer + loser), never more", () => {
    const movers = [
      moverCoin({ symbol: "AAA", change24h: 9 }),
      moverCoin({ symbol: "BBB", change24h: -9 }),
      moverCoin({ symbol: "CCC", change24h: 2 }),
      moverCoin({ symbol: "DDD", change24h: -2 }),
    ];
    const post = buildTopMoversDigestPost(movers);
    assert.equal(countCashtags(post).length, 2);
  });
});

// ---------------------------------------------------------------------------
// v9: buildMarketSpotlightPost — deep-dive on one coin outside the watchlist
// ---------------------------------------------------------------------------
describe("buildMarketSpotlightPost", () => {
  test("returns null for empty/missing input", () => {
    assert.equal(buildMarketSpotlightPost([]), null);
    assert.equal(buildMarketSpotlightPost(null), null);
  });

  test("picks the biggest mover that is OUTSIDE the core 8-coin watchlist", () => {
    const movers = [
      moverCoin({ symbol: "BTC", change24h: 50 }), // core watchlist coin, biggest move but should be skipped
      moverCoin({ symbol: "NEWCO", name: "Newcoin", change24h: 8, rank: 77 }),
    ];
    const post = buildMarketSpotlightPost(movers);
    assert.match(post, /\$NEWCO/);
    assert.doesNotMatch(post, /\$BTC/);
  });

  test("falls back to the biggest mover overall if every mover is in the core watchlist", () => {
    const movers = [
      moverCoin({ symbol: "BTC", change24h: 4 }),
      moverCoin({ symbol: "ETH", change24h: 9 }),
    ];
    const post = buildMarketSpotlightPost(movers);
    assert.match(post, /\$ETH/);
  });

  test("includes ATH distance when available, omits it gracefully when not", () => {
    const withAth = buildMarketSpotlightPost([moverCoin({ symbol: "NEWCO", athChangePct: -60 })]);
    assert.match(withAth, /from its all-time high/);
    const withoutAth = buildMarketSpotlightPost([moverCoin({ symbol: "NEWCO", athChangePct: null })]);
    assert.doesNotMatch(withoutAth, /from its all-time high/);
  });

  test("only uses 1 cashtag", () => {
    const post = buildMarketSpotlightPost([moverCoin({ symbol: "NEWCO" })]);
    assert.equal(countCashtags(post).length, 1);
  });
});

// ---------------------------------------------------------------------------
// v9: Twitter/X OAuth 1.0a signing (percentEncode, buildOAuth1Header)
// ---------------------------------------------------------------------------
describe("percentEncode", () => {
  test("percent-encodes reserved OAuth characters that encodeURIComponent leaves alone", () => {
    // encodeURIComponent leaves ! * ' ( ) unescaped, but OAuth 1.0a's spec
    // requires them escaped — this is the exact gap this function exists to close.
    assert.equal(percentEncode("!"), "%21");
    assert.equal(percentEncode("*"), "%2A");
    assert.equal(percentEncode("'"), "%27");
    assert.equal(percentEncode("("), "%28");
    assert.equal(percentEncode(")"), "%29");
  });

  test("encodes spaces as %20, not +", () => {
    assert.equal(percentEncode("a b"), "a%20b");
  });

  test("leaves unreserved characters untouched", () => {
    assert.equal(percentEncode("abc123-._~"), "abc123-._~");
  });
});

describe("buildOAuth1Header", () => {
  const url = "https://api.x.com/2/tweets";
  const fixedNonce = "abc123nonce";
  const fixedTimestamp = "1700000000";

  test("produces a deterministic signature for fixed inputs (regression guard)", () => {
    const header1 = buildOAuth1Header(url, "consumerKey", "consumerSecret", "tok", "tokSecret", fixedNonce, fixedTimestamp);
    const header2 = buildOAuth1Header(url, "consumerKey", "consumerSecret", "tok", "tokSecret", fixedNonce, fixedTimestamp);
    assert.equal(header1, header2);
  });

  test("includes all required OAuth 1.0a fields", () => {
    const header = buildOAuth1Header(url, "consumerKey", "consumerSecret", "tok", "tokSecret", fixedNonce, fixedTimestamp);
    assert.match(header, /^OAuth /);
    assert.match(header, /oauth_consumer_key="consumerKey"/);
    assert.match(header, /oauth_token="tok"/);
    assert.match(header, /oauth_signature_method="HMAC-SHA1"/);
    assert.match(header, /oauth_version="1\.0"/);
    assert.match(header, /oauth_nonce="abc123nonce"/);
    assert.match(header, /oauth_timestamp="1700000000"/);
    assert.match(header, /oauth_signature="[^"]+"/);
  });

  test("different consumer/token secrets produce different signatures", () => {
    const header1 = buildOAuth1Header(url, "consumerKey", "secretA", "tok", "tokSecret", fixedNonce, fixedTimestamp);
    const header2 = buildOAuth1Header(url, "consumerKey", "secretB", "tok", "tokSecret", fixedNonce, fixedTimestamp);
    assert.notEqual(header1, header2);
  });

  test("different nonces produce different signatures for otherwise identical requests", () => {
    const header1 = buildOAuth1Header(url, "consumerKey", "consumerSecret", "tok", "tokSecret", "nonceA", fixedTimestamp);
    const header2 = buildOAuth1Header(url, "consumerKey", "consumerSecret", "tok", "tokSecret", "nonceB", fixedTimestamp);
    assert.notEqual(header1, header2);
  });

  test("omitting nonce/timestamp still produces a well-formed header (production code path)", () => {
    const header = buildOAuth1Header(url, "consumerKey", "consumerSecret", "tok", "tokSecret");
    assert.match(header, /^OAuth /);
    assert.match(header, /oauth_nonce="[a-f0-9]{32}"/); // crypto.randomBytes(16).toString("hex")
    assert.match(header, /oauth_timestamp="\d+"/);
  });
});
