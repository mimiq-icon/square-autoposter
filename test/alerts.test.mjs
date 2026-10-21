// test/alerts.test.mjs — v10.2: price-alert detection, facts, template, state.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import {
  niceStep, levelsCrossed, fmtUsd, detectAlerts, alertFacts, buildAlertPrompt, buildAlertTemplate,
  assembleAlertPost, buildPriceChartConfig, emptyAlertState, loadAlertState, saveAlertState,
  pruneAlertState, recordAlertClaim, setAlertStatus, removeAlertClaim, alertsToday,
} from "../alerts.mjs";
import { validateNewsCopy, parseNewsAiOutput } from "../news.mjs";

const NOW = Date.UTC(2026, 9, 19, 12, 0, 0);
const snap = (o) => ({ symbol: "BTC", price: 82950, start: 83420, change24h: -1.2, high24h: 84100, low24h: 81900, ...o });

describe("niceStep", () => {
  test("gives round steps near 1.25% of price", () => {
    assert.equal(niceStep(83000), 1000);
    assert.equal(niceStep(3500), 50);
    assert.equal(niceStep(180), 2);
    assert.equal(niceStep(0.25), 0.0025);
  });
  test("garbage in => 0", () => { assert.equal(niceStep(0), 0); assert.equal(niceStep(NaN), 0); });
});

describe("levelsCrossed", () => {
  test("falling through 83,000", () => assert.deepEqual(levelsCrossed(83420, 82950, 1000), [83000]));
  test("rising through 84,000", () => assert.deepEqual(levelsCrossed(83900, 84100, 1000), [84000]));
  test("landing exactly on a level counts as reaching it", () => assert.deepEqual(levelsCrossed(83900, 84000, 1000), [84000]));
  test("no level between => none", () => assert.deepEqual(levelsCrossed(83100, 83900, 1000), []));
  test("several levels in one big move", () => assert.deepEqual(levelsCrossed(82100, 84200, 1000), [83000, 84000]));
});

describe("fmtUsd", () => {
  test("scales decimals by magnitude", () => {
    assert.equal(fmtUsd(82950.4), "$82,950");
    assert.equal(fmtUsd(182.456), "$182.46");
    assert.equal(fmtUsd(0.2512), "$0.2512");
  });
});

describe("detectAlerts", () => {
  test("level cross down is reported with the nearest level", () => {
    const [a] = detectAlerts({ snapshots: [snap()], nowMs: NOW });
    assert.equal(a.kind, "level"); assert.equal(a.dir, "down"); assert.equal(a.level, 83000);
    assert.equal(a.id, "BTC:level:down:83000");
  });
  test("up move picks the highest crossed level", () => {
    const [a] = detectAlerts({ snapshots: [snap({ start: 82100, price: 84200, change24h: 2 })], nowMs: NOW });
    assert.equal(a.dir, "up"); assert.equal(a.level, 84000);
  });
  test("big 24h move without a level cross => move alert", () => {
    const [a] = detectAlerts({ snapshots: [snap({ start: 82950, price: 82950, change24h: -7.3 })], nowMs: NOW });
    assert.equal(a.kind, "move"); assert.equal(a.dir, "down");
  });
  test("quiet market => nothing", () => {
    assert.deepEqual(detectAlerts({ snapshots: [snap({ start: 83100, price: 83200, change24h: 0.4 })], nowMs: NOW }), []);
  });
  test("same level+direction is not repeated within hours, but is after", () => {
    const fired = [{ id: "BTC:level:down:83000", symbol: "BTC", kind: "level", dir: "down", level: 83000, at: NOW - 2 * 3_600_000, status: "posted" }];
    assert.equal(detectAlerts({ snapshots: [snap()], fired, nowMs: NOW }).length, 0);
    const old = [{ ...fired[0], at: NOW - 7 * 3_600_000 }];
    assert.equal(detectAlerts({ snapshots: [snap()], fired: old, nowMs: NOW }).length, 1);
  });
  test("per-coin cooldown blocks any new alert for that coin", () => {
    const fired = [{ id: "BTC:move:up", symbol: "BTC", kind: "move", dir: "up", level: null, at: NOW - 10 * 60_000, status: "posted" }];
    assert.equal(detectAlerts({ snapshots: [snap()], fired, nowMs: NOW }).length, 0);
  });
  test("skipped claims do not block", () => {
    const fired = [{ id: "BTC:level:down:83000", symbol: "BTC", kind: "level", dir: "down", level: 83000, at: NOW - 600_000, status: "skipped" }];
    assert.equal(detectAlerts({ snapshots: [snap()], fired, nowMs: NOW }).length, 1);
  });
  test("ranks BTC above a small coin with the same move, one alert per coin", () => {
    const out = detectAlerts({
      snapshots: [snap({ symbol: "DOGE", price: 0.2, start: 0.2, change24h: -8 }), snap({ symbol: "BTC", price: 82950, start: 82950, change24h: -8 })],
      nowMs: NOW,
    });
    assert.deepEqual(out.map((a) => a.symbol), ["BTC", "DOGE"]);
  });
  test("bad snapshots are ignored", () => {
    assert.deepEqual(detectAlerts({ snapshots: [null, { symbol: "X", price: 0 }, { symbol: "Y", price: NaN }], nowMs: NOW }), []);
  });
});

describe("facts, prompt, template, validation", () => {
  const [a] = detectAlerts({ snapshots: [snap()], nowMs: NOW });
  test("facts contain every figure the post may use", () => {
    const f = alertFacts(a);
    for (const s of ["$82,950", "$83,000", "$83,420", "-1.2%", "$84,100", "$81,900", "fell below"]) assert.ok(f.includes(s), s);
  });
  test("prompt carries the facts and forbids invention", () => {
    const p = buildAlertPrompt(a);
    assert.ok(p.includes(alertFacts(a)));
    assert.match(p, /Never add numbers/);
  });
  test("template headline is data-only and passes the news validator", () => {
    const t = buildAlertTemplate(a);
    assert.equal(t.headline, "Bitcoin falls below $83,000, now trading at $82,950");
    assert.deepEqual(validateNewsCopy({ headline: t.headline, context: null }, alertFacts(a)), { ok: true });
  });
  test("a faithful AI answer validates; an invented number is rejected", () => {
    const good = parseNewsAiOutput("HEADLINE: Bitcoin drops below $83,000 and now trades at $82,950\nCONTEXT: It is down 1.2% over the past 24 hours.");
    assert.equal(validateNewsCopy(good, alertFacts(a)).ok, true);
    const bad = parseNewsAiOutput("HEADLINE: Bitcoin drops below $83,000 and now trades at $82,950\nCONTEXT: Analysts see $90,000 next.");
    assert.equal(validateNewsCopy(bad, alertFacts(a)).ok, false);
  });
  test("move-kind template and facts", () => {
    const [m] = detectAlerts({ snapshots: [snap({ start: 82950, change24h: 7.34 })], nowMs: NOW });
    assert.equal(m.kind, "move");
    assert.equal(buildAlertTemplate(m).headline, "Bitcoin is up 7.3% in 24 hours, now at $82,950");
  });
});

describe("assembleAlertPost", () => {
  const [a] = detectAlerts({ snapshots: [snap()], nowMs: NOW });
  test("one cashtag, hashtags capped at 2, disclaimer before the tags", () => {
    const t = assembleAlertPost({ alert: a, headline: "H", context: "C.", disclaimer: "Not financial advice.", hashtags: ["#Bitcoin", "#Crypto", "#Extra"] });
    assert.equal(t, "🔻 H\n\nC.\n\nNot financial advice.\n$BTC #Bitcoin #Crypto");
  });
  test("works without context or disclaimer", () => {
    assert.equal(assembleAlertPost({ alert: a, headline: "H", context: null, hashtags: [] }), "🔻 H\n$BTC");
  });
});

describe("buildPriceChartConfig", () => {
  test("price line + dashed level line", () => {
    const c = buildPriceChartConfig({ symbol: "BTC", closes: [1, 2, 3, 4], level: 2.5 });
    assert.equal(c.data.datasets.length, 2);
    assert.equal(c.data.labels.at(-1), "now");
    assert.deepEqual(c.data.datasets[1].data, [2.5, 2.5, 2.5, 2.5]);
  });
  test("no level => one line; too little data => null", () => {
    assert.equal(buildPriceChartConfig({ symbol: "ETH", closes: [1, 2, 3] }).data.datasets.length, 1);
    assert.equal(buildPriceChartConfig({ symbol: "ETH", closes: [1] }), null);
  });
});

describe("alert state", () => {
  const [a] = detectAlerts({ snapshots: [snap()], nowMs: NOW });
  test("claim → posted → counts today; release removes the claim", () => {
    let s = recordAlertClaim(emptyAlertState(), a, NOW, "pending");
    assert.equal(alertsToday(s, NOW), 1);
    s = setAlertStatus(s, a, "posted");
    assert.equal(s.fired[0].status, "posted");
    s = removeAlertClaim(s, a);
    assert.equal(s.fired.length, 0);
  });
  test("skipped claims do not count toward the daily cap", () => {
    const s = setAlertStatus(recordAlertClaim(emptyAlertState(), a, NOW, "pending"), a, "skipped");
    assert.equal(alertsToday(s, NOW), 0);
  });
  test("yesterday does not count; old entries are pruned", () => {
    const s = recordAlertClaim(emptyAlertState(), a, NOW - 30 * 3_600_000, "posted");
    assert.equal(alertsToday(s, NOW), 0);
    assert.equal(pruneAlertState(s, NOW).fired.length, 1);
    assert.equal(pruneAlertState(s, NOW + 30 * 3_600_000).fired.length, 0);
  });
  test("save/load round-trips; missing or corrupt file => empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alerts-"));
    const f = path.join(dir, "n", "alerts.json");
    saveAlertState(f, recordAlertClaim(emptyAlertState(), a, NOW, "posted"));
    assert.equal(loadAlertState(f).fired.length, 1);
    assert.deepEqual(loadAlertState(path.join(dir, "nope.json")), emptyAlertState());
    fs.writeFileSync(f, "{not json");
    assert.deepEqual(loadAlertState(f), emptyAlertState());
  });
});

describe("v11.2 extremeMove: images only for violent moves", async () => {
  const { extremeMove } = await import("../alerts.mjs");
  const base = { symbol: "BTC", price: 82950, start: 83100, change24h: -1.2, lookbackMin: 30 };
  test("a quiet level cross is not extreme (text-only post)", () => {
    assert.equal(extremeMove(base).extreme, false);
  });
  test("a big 24h move is extreme, with direction and the 24h label", () => {
    const r = extremeMove({ ...base, change24h: -8.6 });
    assert.deepEqual([r.extreme, r.dir, r.label], [true, "down", "in 24h"]);
  });
  test("a fast move inside the lookback window is extreme and wins the label", () => {
    const r = extremeMove({ ...base, start: 80000, price: 83000, change24h: 2 });
    assert.deepEqual([r.extreme, r.dir, r.label], [true, "up", "in 30 min"]);
    assert.ok(r.pct > 3);
  });
  test("thresholds are configurable and missing data is safe", () => {
    assert.equal(extremeMove({ ...base, change24h: 5 }, { movePct: 5 }).extreme, true);
    assert.equal(extremeMove({ symbol: "X" }).extreme, false);
    assert.equal(extremeMove(undefined).extreme, false);
  });
});
