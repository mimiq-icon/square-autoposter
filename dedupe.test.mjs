// test/dedupe.test.mjs — v11.1: duplicates seen in production (the SkyAI
// double post, ETF-flow repeats), speculative context lines, chart windows,
// and the impossible-volume guard.
//
// v11.1: the v10.2 topicKeys()/isAlreadyPosted() window mechanism was
// superseded by etfFlowBlock() pacing (claims carry an etfFlow tag in shared
// state; one flows story per coin per 10h). Those behaviours are covered in
// news-opinion.test.mjs; this file keeps the normalisation, chart-window,
// opinion and sanity regressions.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { sameStory, titleTokens, validateNewsCopy, clusterStories } from "../news.mjs";
import { chartWindow, buildPriceChartConfig } from "../alerts.mjs";
import { sanePositiveBelow } from "../post.mjs";

const NOW = Date.UTC(2026, 9, 20, 8, 0, 0);
const cluster = (title) => clusterStories([{ title, summary: "", source: "X", link: `https://x.test/${encodeURIComponent(title)}`, publishedAt: NOW - 600_000 }])[0];

describe("same story, different outlets and wording (the SkyAI double post)", () => {
  const A = "SkyAI sells off entire Solana treasury as it launches $201 million buyback";
  const B = "Solana treasury firm SkyAI sells all SOL holdings, launches $201M buyback";
  test("'$201 million' = '$201M' and SOL = Solana", () => {
    // v11.1: units normalise to a canonical magnitude-preserving token ("201m"),
    // and detected coins contribute their symbol ("sol") to both titles.
    assert.ok(titleTokens(A).has("201m") && titleTokens(B).has("201m"));
    assert.ok(titleTokens(A).has("sol") && titleTokens(B).has("sol"));
    assert.equal(sameStory(A, B), true);
  });
  test("a cluster containing B is caught as the same story as a posted A", () => {
    const state = { posted: [{ title: A, link: "https://other.test/1", source: "Y", at: NOW - 4 * 3_600_000, status: "posted" }] };
    assert.equal(
      cluster(B).items.some((i) => state.posted.some((p) => (i.link && p.link && i.link === p.link) || sameStory(i.title, p.title))),
      true,
    );
  });
  test("genuinely different stories are still different", () => {
    assert.equal(sameStory(A, "Bitmine adds 12,535 ETH as treasury reaches 6.04 million tokens"), false);
    assert.equal(sameStory("Bitcoin ETFs draw $500M", "Ethereum ETFs draw $500M"), false);
    assert.equal(sameStory("Exchange A hacked for $50 million", "Exchange B hacked for $60 million"), false);
  });
  test("units: billion / bn / B all match, magnitudes stay distinct", () => {
    assert.equal(sameStory("Fund buys $1.2 billion of Bitcoin", "Fund buys $1.2B of Bitcoin"), true);
    assert.equal(sameStory("Fund buys $1.2 billion of Bitcoin", "Fund buys $1.2bn of Bitcoin"), true);
    // v11.1 regression guard: "$7M" and "$7B" keep different amount tokens...
    assert.notEqual(titleTokens("Fund buys $7M of Bitcoin").has("7b"), true);
    assert.ok(titleTokens("Fund buys $7M of Bitcoin").has("7m"));
    assert.ok(titleTokens("Fund buys $7B of Bitcoin").has("7b"));
  });
});

describe("context lines must be facts, not opinions", () => {
  const src = "BlackRock's IBIT Bitcoin ETF draws $665 million inflow. Min Jung suggests investors may prepare for a potential catch-up trade in Bitcoin.";
  const headline = "BlackRock's Bitcoin ETF draws $665 million inflow";
  test("the speculative line seen in production is rejected", () => {
    const v = validateNewsCopy({ headline, context: "Min Jung suggests investors may prepare for a potential 'catch-up trade' in Bitcoin." }, src);
    assert.equal(v.ok, false); assert.match(v.reason, /opinion/);
  });
  test("a plain factual context is fine, and no context is fine", () => {
    assert.equal(validateNewsCopy({ headline, context: "It is the largest inflow since October 2025." }, src.replace("catch-up trade", "catch-up trade. Largest since October 2025")).ok, true);
    assert.equal(validateNewsCopy({ headline, context: null }, src).ok, true);
  });
});

describe("chart window", () => {
  test("candle size scales with the span", () => {
    assert.deepEqual(chartWindow(24), { hours: 24, interval: "15m", limit: 96 });
    assert.deepEqual(chartWindow(48), { hours: 48, interval: "1h", limit: 48 });
    assert.deepEqual(chartWindow(168), { hours: 168, interval: "4h", limit: 42 });
    assert.deepEqual(chartWindow(24 * 30), { hours: 720, interval: "1d", limit: 30 });
  });
  test("garbage and extremes are clamped", () => {
    assert.equal(chartWindow("abc").hours, 24);
    assert.equal(chartWindow(1).hours, 6);
    assert.equal(chartWindow(99999).hours, 720);
  });
  test("long spans are labelled in days, with a human title", () => {
    const c = buildPriceChartConfig({ symbol: "BTC", closes: [1, 2, 3, 4, 5, 6, 7, 8], hours: 168 });
    assert.equal(c.data.labels[0], "-7d"); assert.equal(c.data.labels.at(-1), "now");
    assert.match(c.options.title.text, /last 7 days/);
    assert.match(buildPriceChartConfig({ symbol: "BTC", closes: [1, 2, 3], hours: 24 }).options.title.text, /last 24h/);
  });
});

describe("impossible global volume", () => {
  test("volume above the whole market cap (or junk) becomes null", () => {
    assert.equal(sanePositiveBelow(3.46e17, 2.74e12), null);
    assert.equal(sanePositiveBelow(0, 2.74e12), null);
    assert.equal(sanePositiveBelow(undefined, 2.74e12), null);
    assert.equal(sanePositiveBelow(1.1e11, 2.74e12), 1.1e11);
  });
});
