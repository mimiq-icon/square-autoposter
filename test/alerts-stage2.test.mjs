import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  extremeMove, detectAlerts, contextFromCandles, fmtShortDate, crossCheckVerdict, priceDivergencePct,
  alertChartStyle, alertFacts, buildAlertTemplate, COINGECKO_IDS, DEFAULT_ALERT_CFG, DEFAULT_ALERT_COINS,
} from "../alerts.mjs";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const snap = (o) => ({ symbol: "BNB", price: 735, start: 744, change24h: -1.1, high24h: 750, low24h: 730, ...o });

describe("level alerts need a clean crossing (the BNB $739.98 noise)", () => {
  test("drifting from 740.31 to 739.98 does not 'fall below $740'", () => {
    assert.deepEqual(detectAlerts({ snapshots: [snap({ start: 740.31, price: 739.98 })], nowMs: NOW }), []);
  });
  test("chatter the other way is also ignored", () => {
    assert.deepEqual(detectAlerts({ snapshots: [snap({ start: 739.9, price: 740.2, change24h: 0.2 })], nowMs: NOW }), []);
  });
  test("a decisive move through 740 still alerts", () => {
    const [a] = detectAlerts({ snapshots: [snap({ start: 744, price: 735 })], nowMs: NOW });
    assert.equal(a.kind, "level"); assert.equal(a.level, 740); assert.equal(a.dir, "down");
  });
  test("the old behaviour is available with levelMarginPct 0", () => {
    const [a] = detectAlerts({ snapshots: [snap({ start: 740.31, price: 739.98 })], nowMs: NOW, cfg: { levelMarginPct: 0 } });
    assert.equal(a.level, 740);
  });
  test("when the nearest level is not clean, an earlier clean one is used", () => {
    const [a] = detectAlerts({ snapshots: [snap({ symbol: "BTC", start: 82100, price: 84050, change24h: 2 })], nowMs: NOW });
    assert.equal(a.level, 83000); assert.equal(a.dir, "up");
  });
  test("default margin is 0.15%", () => assert.equal(DEFAULT_ALERT_CFG.levelMarginPct, 0.15));
});

describe("fmtShortDate: AP style, UTC", () => {
  test("months", () => {
    assert.equal(fmtShortDate(Date.UTC(2026, 9, 14)), "Oct. 14");
    assert.equal(fmtShortDate(Date.UTC(2026, 2, 3)), "March 3");
    assert.equal(fmtShortDate(Date.UTC(2026, 8, 5)), "Sept. 5");
    assert.equal(fmtShortDate(Date.UTC(2026, 5, 30)), "June 30");
  });
});

// 168 hourly candles ending now; all trade well above `price` except one dip `hoursAgo` hours back.
function hourly({ price, hoursAgo = null, n = 168, above = 1.06, dipLow = 0.97 }) {
  return Array.from({ length: n }, (_, i) => {
    const t = NOW - (n - i) * 3_600_000;
    const dip = hoursAgo != null && i === n - hoursAgo;
    return { openTime: t, open: price * above, high: price * above * 1.01, low: dip ? price * dipLow : price * above * 0.99, close: price * above };
  });
}

describe("contextFromCandles: 'lowest since Oct. 14'", () => {
  test("a fall reports the last time the price was this low", () => {
    const price = 79450;
    const c = contextFromCandles({ price, dir: "down", candles: hourly({ price, hoursAgo: 100 }), nowMs: NOW });
    assert.equal(c.kind, "since");
    assert.match(c.text, /^lowest since [A-Z][a-z]+\.? \d{1,2}$/);
    const closeOfDip = NOW - 100 * 3_600_000 + 3_600_000;
    assert.equal(c.text, `lowest since ${fmtShortDate(closeOfDip)}`);
  });
  test("a rise reports 'highest since'", () => {
    const price = 100;
    const candles = hourly({ price, above: 0.9 }).map((c, i, a) => (i === a.length - 90 ? { ...c, high: 101 } : c));
    const c = contextFromCandles({ price, dir: "up", candles, nowMs: NOW });
    assert.match(c.text, /^highest since /);
  });
  test("nothing that low in the whole window gives 'in at least N days'", () => {
    const price = 79450;
    const c = contextFromCandles({ price, dir: "down", candles: hourly({ price }), nowMs: NOW });
    assert.deepEqual({ kind: c.kind, days: c.days }, { kind: "window", days: 7 });
    assert.equal(c.text, "lowest in at least 7 days");
  });
  test("a dip under 24 hours ago is not news", () => {
    const price = 79450;
    assert.equal(contextFromCandles({ price, dir: "down", candles: hourly({ price, hoursAgo: 10 }), nowMs: NOW }), null);
  });
  test("too little history gives nothing", () => {
    const price = 79450;
    assert.equal(contextFromCandles({ price, dir: "down", candles: hourly({ price, n: 40 }), nowMs: NOW }), null);
    assert.equal(contextFromCandles({ price, dir: "down", candles: [], nowMs: NOW }), null);
    assert.equal(contextFromCandles({ price, dir: "sideways", candles: hourly({ price }), nowMs: NOW }), null);
  });
  test("the last two candles (the move itself) are ignored", () => {
    const price = 79450;
    const candles = hourly({ price }).map((c, i, a) => (i >= a.length - 2 ? { ...c, low: price * 0.9 } : c));
    assert.equal(contextFromCandles({ price, dir: "down", candles, nowMs: NOW }).kind, "window");
  });
});

describe("alert text carries the context", () => {
  const a = { kind: "level", symbol: "BTC", name: "Bitcoin", dir: "down", level: 80000, price: 79450, start: 80600, change24h: -3.1, high24h: 82100, low24h: 79200, lookbackMin: 30, context: { text: "lowest since Oct. 14" } };
  test("facts include a Context line, so the validator allows the date", () => {
    assert.match(alertFacts(a), /Context: Bitcoin is at its lowest since Oct\. 14/);
  });
  test("the template leads its context with it", () => {
    assert.match(buildAlertTemplate(a).context, /^Lowest since Oct\. 14; 24h change -3\.1%/);
  });
  test("without context nothing changes", () => {
    const { context, ...plain } = a;
    assert.doesNotMatch(alertFacts(plain), /Context:/);
    assert.match(buildAlertTemplate(plain).context, /^24h change/);
  });
});

describe("second price source", () => {
  test("close prices pass", () => {
    const v = crossCheckVerdict({ price: 82700, other: 82810 });
    assert.equal(v.ok, true); assert.equal(v.checked, true); assert.ok(v.divergencePct < 0.2);
  });
  test("a 5% gap is held", () => {
    const v = crossCheckVerdict({ price: 82700, other: 78000 });
    assert.equal(v.ok, false); assert.equal(v.checked, true);
  });
  test("tolerance is adjustable", () => assert.equal(crossCheckVerdict({ price: 100, other: 103, tolerancePct: 5 }).ok, true));
  test("no second price means unchecked, never blocked", () => {
    for (const other of [null, undefined, NaN, 0]) assert.deepEqual({ ok: crossCheckVerdict({ price: 100, other }).ok, checked: crossCheckVerdict({ price: 100, other }).checked }, { ok: true, checked: false });
  });
  test("divergence is symmetric", () => assert.equal(priceDivergencePct(100, 103).toFixed(6), priceDivergencePct(103, 100).toFixed(6)));
  test("every default watchlist coin has a CoinGecko id", () => {
    for (const s of DEFAULT_ALERT_COINS) assert.ok(COINGECKO_IDS[s], s);
  });
});

describe("alert chart style", () => {
  test("line is the default", () => { for (const v of [undefined, "", "line", "garbage"]) assert.equal(alertChartStyle(v), "line"); });
  test("candles is opt-in", () => { for (const v of ["candles", "Candle", " CANDLES "]) assert.equal(alertChartStyle(v), "candles"); });
});

describe("extremeMove: the card's hero agrees with the headline", () => {
  const base = { symbol: "BTC", price: 79450, start: 82100, lookbackMin: 30 };
  test("a 24h-move alert shows the 24h figure even when a 30-minute flash is also big", () => {
    const r = extremeMove({ ...base, kind: "move", change24h: -9 });
    assert.deepEqual({ pct: r.pct, label: r.label }, { pct: -9, label: "in 24h" });
  });
  test("a level alert still leads with the fast move", () => {
    const r = extremeMove({ ...base, kind: "level", level: 80000, change24h: -9 });
    assert.equal(r.label, "in 30 min");
  });
  test("a move alert under the extreme threshold falls back to the flash move", () => {
    assert.equal(extremeMove({ ...base, kind: "move", change24h: -5.5 }).label, "in 30 min");
  });
});
