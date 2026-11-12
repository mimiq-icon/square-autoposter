import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseStablecoins, describeStablecoins, parseChains, describeChains, parseProtocolFees, describeProtocolFees,
  parseDifficulty, describeDifficulty, parseTipHeight, bitcoinSupplyAt, describeSupply, parsePools, describePools,
  gatherFacts, researchChartFor, minSourcesFor, needFamily, RESEARCH_TOPICS,
} from "../research.mjs";
import { buildRankedBarsSvg } from "../cards.mjs";
import { lintStyle } from "../style.mjs";
import * as F from "../test-support/fixtures.mjs";

const NOW = Date.UTC(2026, 10, 10, 12);

describe("stablecoins (DefiLlama): circulating is an object keyed by peg type", () => {
  const d = parseStablecoins(F.STABLECOINS);
  test("reads the keyed objects, USD-pegged only, junk rows dropped, biggest first", () => {
    assert.deepEqual(d.top.map((c) => c.symbol), ["USDT", "USDC", "USDe", "DAI"]);
    assert.equal(d.count, 4);
    assert.equal(d.total, 187_200_000_000 + 72_900_000_000 + 6_400_000_000 + 5_300_000_000);
  });
  test("7-day change from circulatingPrevWeek, null when it is missing", () => {
    assert.equal(d.top[0].change7d.toFixed(2), "0.65");
    assert.equal(d.top.find((c) => c.symbol === "DAI").change7d.toFixed(2), "-1.85");
    assert.equal(d.top.find((c) => c.symbol === "USDe").change7d, null);
  });
  test("a plain-number circulating (a flattened shape) also works", () => {
    const p = parseStablecoins({ peggedAssets: [{ name: "X", symbol: "X", pegType: "peggedUSD", circulating: 5e9 }] });
    assert.equal(p.top[0].circulating, 5e9);
  });
  test("description states totals, shares and weekly change", () => {
    const t = describeStablecoins(d);
    assert.match(t, /^USD-pegged stablecoins in circulation total about \$271\.80B across 4 tracked coins\./);
    assert.match(t, /USDT \(\$187\.20B, 68\.9% of the total, \+0\.6% in 7d\)/);
    assert.match(t, /DAI \(\$5\.30B, 1\.9% of the total, −1\.9% in 7d\)/);
  });
  test("an unexpected shape gives an empty description, never a throw", () => {
    for (const bad of [null, {}, [], { peggedAssets: "x" }, { peggedAssets: [{}] }]) assert.equal(describeStablecoins(parseStablecoins(bad)), "");
  });
});

describe("chains and fees (DefiLlama)", () => {
  test("chains: ranked by TVL, junk dropped", () => {
    const d = parseChains(F.CHAINS);
    assert.deepEqual(d.top.map((c) => c.name).slice(0, 3), ["Ethereum", "Solana", "BSC"]);
    assert.equal(d.count, 6);
    assert.match(describeChains(d), /^6 chains hold about \$101\.70B in TVL in total\. Largest: Ethereum \(\$72\.00B, 70\.8% of the total\)/);
  });
  test("fees: displayName preferred, zero rows dropped, total from the response", () => {
    const d = parseProtocolFees(F.FEES);
    assert.deepEqual(d.top.map((p) => p.name), ["Tether", "Circle", "Uniswap", "Lido", "Aave"]);
    assert.equal(d.total, 95_000_000);
    assert.match(describeProtocolFees(d), /^Protocols collected about \$95\.00M in fees in the last 24 hours\. Largest: Tether \(\$30\.00M, 31\.6% of the total\)/);
  });
  test("bad shapes are empty", () => {
    assert.equal(describeChains(parseChains({ nope: 1 })), "");
    assert.equal(describeProtocolFees(parseProtocolFees("x")), "");
  });
});

describe("mempool.space: difficulty, block height, pools", () => {
  test("difficulty adjustment is read and described", () => {
    const d = parseDifficulty(F.difficulty(NOW));
    assert.deepEqual({ p: d.progressPct, r: d.remainingBlocks, c: d.changePct, prev: d.previousPct }, { p: 62.4, r: 758, c: -1.8, prev: 2.3 });
    const t = describeDifficulty(d, NOW);
    assert.match(t, /^The current difficulty period is 62\.4% complete, with 758 blocks to go \(about 5\.3 days at ten minutes a block\)\. The next adjustment is projected at −1\.8%; the last one was \+2\.3%\. Projected date: 2026-11-15\.$/);
  });
  test("estimatedRetargetDate in seconds or milliseconds both work; an implausible date is omitted", () => {
    const base = F.difficulty(NOW);
    assert.match(describeDifficulty(parseDifficulty({ ...base, estimatedRetargetDate: Math.floor((NOW + 3 * 86_400_000) / 1000) }), NOW), /Projected date: 2026-11-13/);
    assert.match(describeDifficulty(parseDifficulty({ ...base, estimatedRetargetDate: NOW + 3 * 86_400_000 }), NOW), /Projected date: 2026-11-13/);
    assert.doesNotMatch(describeDifficulty(parseDifficulty({ ...base, estimatedRetargetDate: 1627762478 }), NOW), /Projected date/);
    assert.doesNotMatch(describeDifficulty(parseDifficulty({ ...base, estimatedRetargetDate: undefined }), NOW), /Projected date/);
  });
  test("difficulty: missing fields mean null, not a half-empty sentence", () => {
    assert.equal(parseDifficulty({ progressPercent: 10 }), null);
    assert.equal(describeDifficulty(null), "");
  });
  test("tip height accepts a number or a numeric string, rejects the rest", () => {
    assert.equal(parseTipHeight(940123), 940123);
    assert.equal(parseTipHeight("940123\n"), 940123);
    for (const bad of [null, "abc", -4, 1.5, {}, 0]) assert.equal(parseTipHeight(bad), null);
  });
  test("pools: ranked, shares computed from block counts, zero-block pools dropped", () => {
    const d = parsePools(F.POOLS);
    assert.equal(d.blocks, 780);
    assert.deepEqual(d.top.map((p) => p.name), ["Foundry USA", "AntPool", "F2Pool", "ViaBTC", "Binance Pool"]);
    assert.equal(d.top[0].sharePct.toFixed(1), "38.8");
    assert.match(describePools(d), /^Over the past week 780 blocks were mined\. Largest pools: Foundry USA \(38\.8% of blocks, 303 blocks\)/);
  });
});

describe("Bitcoin supply from block height (pure arithmetic, checked against known chain facts)", () => {
  test("just before the 4th halving: exactly 19,687,500 BTC mined, next block pays 3.125", () => {
    const s = bitcoinSupplyAt(839_999);
    assert.deepEqual({ mined: s.minedBtc, subsidy: s.subsidyBtc, halvings: s.halvingsDone, next: s.nextHalvingHeight, toGo: s.blocksToHalving }, { mined: 19_687_500, subsidy: 3.125, halvings: 4, next: 1_050_000, toGo: 210_000 });
  });
  test("the 4th halving block itself adds 3.125 BTC", () => {
    assert.equal(bitcoinSupplyAt(840_000).minedBtc, 19_687_503.125);
  });
  test("end of the first era: 10.5 million BTC, and block 210,000 starts the 25 BTC era", () => {
    assert.equal(bitcoinSupplyAt(209_999).minedBtc, 10_500_000);
    assert.equal(bitcoinSupplyAt(209_999).subsidyBtc, 25);
    assert.equal(bitcoinSupplyAt(100_000).subsidyBtc, 50);
  });
  test("supply never exceeds the 21 million cap, even far in the future", () => {
    for (const h of [1_000_000, 2_000_000, 6_929_999, 10_000_000]) assert.ok(bitcoinSupplyAt(h).minedBtc <= 21_000_000, String(h));
  });
  test("the description is plain wire copy with the right figures", () => {
    const t = describeSupply(bitcoinSupplyAt(F.TIP_HEIGHT));
    assert.match(t, /The Bitcoin chain is at block 940,123\. The block subsidy is 3\.125 BTC after 4 halvings\. The next halving is at block 1,050,000, 109,876 blocks away, about 763 days at ten minutes a block\. About 20\.00 million of the 21 million BTC cap \(95\.2%\) has been mined\./);
    assert.equal(lintStyle(t, { kind: "research" }).ok, true);
  });
});

// ---- regression guard: every topic works against realistic responses ----
const route = (nowMs) => async (url) => {
  const u = String(url);
  const json = (b) => new Response(JSON.stringify(b), { status: 200 });
  if (u.includes("stablecoins.llama.fi/stablecoins")) return json(F.STABLECOINS);
  if (u.includes("api.llama.fi/v2/chains")) return json(F.CHAINS);
  if (u.includes("api.llama.fi/overview/fees")) return json(F.FEES);
  if (u.includes("api.llama.fi/overview/dexs")) return json({ protocols: [{ name: "Uniswap", volume24h: 3.1e9, change_1d: 4.2 }, { name: "Raydium", volume24h: 1.9e9, change_1d: -1.1 }, { name: "Curve", volume24h: 0.9e9, change_1d: 0.2 }], totalDataChart: [[1, { volume: 8.4e9 }], [2, { volume: 7.9e9 }]] });
  if (u.includes("api.llama.fi/protocols")) return json([{ name: "Lido", symbol: "LDO", tvl: 33e9, change_1d: -0.6 }, { name: "Aave", symbol: "AAVE", tvl: 21e9, change_1d: 1.4 }, { name: "EigenLayer", symbol: "EIGEN", tvl: 12e9, change_1d: 3.2 }]);
  if (u.includes("difficulty-adjustment")) return json(F.difficulty(nowMs));
  if (u.includes("blocks/tip/height")) return json(F.TIP_HEIGHT);
  if (u.includes("mining/pools/1w")) return json(F.POOLS);
  if (u.includes("mining/hashrate")) return json(F.HASHRATE);
  if (u.includes("fees/recommended")) return json({ fastestFee: 12, halfHourFee: 9, hourFee: 7, economyFee: 5, minimumFee: 1 });
  if (u.includes("en.wikipedia.org")) { const title = decodeURIComponent(u.split("/summary/")[1]); return json({ title, extract: `${title} is a topic in crypto.` }); }
  return new Response("", { status: 404 });
};

describe("every research topic gathers, meets its minimum, and builds a valid chart", () => {
  test("there are 17 topics, with unique ids", () => {
    assert.equal(RESEARCH_TOPICS.length, 17);
    assert.equal(new Set(RESEARCH_TOPICS.map((t) => t.id)).size, 17);
  });
  for (const topic of RESEARCH_TOPICS) {
    test(topic.id, async () => {
      const facts = await gatherFacts(topic, { fetchFn: route(NOW), retries: 0, nowMs: NOW });
      assert.deepEqual(facts.failures.map((b) => `${b.need}: ${b.error}`), [], "no source may fail against realistic responses");
      assert.ok(facts.families.length >= minSourcesFor(topic, {}), "meets the minimum number of independent sources");
      assert.doesNotMatch(facts.factsText, /NaN|undefined|Infinity|\[object/);
      if (topic.defs?.length) assert.match(facts.factsText, /Concept notes:/);
      if (topic.kind === "research" && topic.needs.some((n) => !n.startsWith("wiki:") && n !== "mempool-hashrate" && n !== "mempool-fees")) {
        const chart = researchChartFor(facts, topic);
        assert.ok(chart, "a data topic must have a chart");
        assert.ok(chart.rows.length >= 3 && chart.rows.every((r) => r.value > 0 && r.valueText));
        const svg = buildRankedBarsSvg({ title: chart.title, subtitle: chart.subtitle, rows: chart.rows, source: chart.source });
        assert.match(svg, /^<svg/);
        assert.ok(svg.includes(chart.rows[0].label));
        assert.ok(!/NaN|undefined/.test(svg));
      }
    });
  }
  test("a topic's chartNeed picks its own chart", async () => {
    const topic = RESEARCH_TOPICS.find((t) => t.id === "where-defi-lives");
    const facts = await gatherFacts(topic, { fetchFn: route(NOW), retries: 0, nowMs: NOW });
    assert.match(researchChartFor(facts, topic).title, /by chain/);
  });
  test("new two-source topics are not postable on one source", () => {
    for (const id of ["how-halving-works", "how-difficulty-adjusts", "stablecoin-supply"]) {
      const t = RESEARCH_TOPICS.find((x) => x.id === id);
      assert.equal(new Set(t.needs.map(needFamily)).size, 2, id);
      assert.equal(minSourcesFor(t, {}), 2, id);
    }
  });
  test("every concept note passes the voice lint (it is text the writer will echo)", () => {
    for (const t of RESEARCH_TOPICS) for (const d of t.defs || []) assert.equal(lintStyle(d, { kind: "research" }).ok, true, `${t.id}: ${d}`);
  });
  test("ranked bars: leader highlighted, no green or red, no 'NaN' with odd input", () => {
    const svg = buildRankedBarsSvg({ title: "T", rows: [{ label: "A", value: 10, valueText: "10" }, { label: "B", value: 5, valueText: "5" }, { label: "Bad", value: NaN }, { label: "Neg", value: -3 }] });
    assert.ok(!svg.includes("#0ECB81") && !svg.includes("#F6465D"));
    assert.equal((svg.match(/opacity="1"/g) || []).length, 1);
    assert.ok(!svg.includes("Bad") && !svg.includes("Neg") && !/NaN/.test(svg));
  });
});

describe("RESEARCH_DATA_DAY: which weekday publishes the short data post", async () => {
  const { parseDataDay } = await import("../research.mjs");
  test("default is Friday", () => { for (const v of [undefined, null, "", "  "]) assert.equal(parseDataDay(v), 5); });
  test("weekday names and numbers", () => {
    assert.equal(parseDataDay("fri"), 5); assert.equal(parseDataDay("Friday"), 5);
    assert.equal(parseDataDay("Tue"), 2); assert.equal(parseDataDay("wednesday"), 3);
    assert.equal(parseDataDay("sun"), 0); assert.equal(parseDataDay("0"), 0); assert.equal(parseDataDay("4"), 4);
  });
  test("off switches it off", () => { for (const v of ["off", "OFF", "none", "false", "no"]) assert.equal(parseDataDay(v), null); });
  test("Saturday is refused (reserved for the monthly article), and nonsense is off", () => {
    for (const v of ["sat", "saturday", "6", "7", "someday", "-1"]) assert.equal(parseDataDay(v), null, v);
  });
});
