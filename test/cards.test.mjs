// test/cards.test.mjs — the card engine. The engine is pure, so these tests
// assert the SVG text itself: same input in, byte-identical SVG out; nothing
// unescaped; nothing overflows its line budget; every builder's required
// content is present. Rendering to PNG is optional by design and only smoke-
// tested when @resvg/resvg-js happens to be installed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  BRAND, esc, wrapText, fmtSignedPct, fmtUsdCompact, fmtPrice,
  buildNewsCardSvg, buildAlertCardSvg, buildExplainerSlideSvg, buildBarChartSvg,
  buildStatGridSvg, buildLineChartSvg, buildArticleCoverSvg, renderSvgToPng,
  buildExtremeAlertCardSvg, brandMarkSvg, aggregateCandles, hasCandles,
} from "../cards.mjs";

const HEADLINE = "Solana treasury firm SkyAI sells all SOL holdings after $201 million buyback";

describe("text tools", () => {
  test("esc escapes XML-dangerous characters", () => {
    assert.equal(esc('<b class="x">&\''), "&lt;b class=&quot;x&quot;&gt;&amp;&apos;");
  });

  test("wrapText fits within the budget and marks silent drops", () => {
    // Fits exactly: no ellipsis.
    assert.deepEqual(wrapText("aaaa bbbb cccc dddd", 9, 2), ["aaaa bbbb", "cccc dddd"]);
    // One word too many: last line gets an ellipsis.
    const over = wrapText("aaaa bbbb cccc dddd eeee", 9, 2);
    assert.equal(over.length, 2);
    assert.match(over[1], /…$/);
    // Nothing at all.
    assert.deepEqual(wrapText("", 9, 2), []);
    // Degenerate budgets can't crash (below the 4-char floor => empty).
    assert.deepEqual(wrapText("hello", 2, 3), []);
    assert.deepEqual(wrapText("hello", 4, 1), ["hel…"]);
  });

  test("wrapText hard-truncates words longer than the budget", () => {
    const lines = wrapText("supercalifragilistic end", 9, 3);
    assert.match(lines[0], /^supercal…$/);
    assert.equal(lines[1], "end");
  });

  test("formatters: percentages, money and prices", () => {
    assert.equal(fmtSignedPct(1.44), "+1.4%");
    assert.equal(fmtSignedPct(-2.1), "−2.1%");
    assert.equal(fmtSignedPct(0), "0.0%");
    assert.equal(fmtSignedPct(undefined), "n/a");
    assert.equal(fmtUsdCompact(4.2e9), "$4.20B");
    assert.equal(fmtUsdCompact(91234), "$91.23K");
    assert.equal(fmtPrice(67420.53), "$67,421");
    assert.equal(fmtPrice(0.5231), "$0.5231");
    assert.equal(fmtPrice(0.0000123), "$0.0000123");
    assert.equal(fmtPrice(NaN), "n/a");
  });
});

describe("news card", () => {
  const opts = {
    headline: HEADLINE,
    context: "The firm moved its remaining SOL to exchanges over two days.",
    source: "The Block, Cointelegraph",
    coins: [{ symbol: "$SOL", change24h: -3.2 }, { symbol: "$BTC", change24h: 1.4 }],
    disclaimer: "Not financial advice.",
  };

  test("deterministic: same input, byte-identical SVG", () => {
    assert.equal(buildNewsCardSvg(opts), buildNewsCardSvg(opts));
  });

  test("contains the headline, context and source; the disclaimer stays in the post text, not on the image", () => {
    const svg = buildNewsCardSvg(opts);
    assert.match(svg, /Solana treasury firm/);
    assert.match(svg, /moved its remaining SOL/);
    assert.match(svg, /The Block\s+·\s+Cointelegraph/);
    assert.ok(!/Source:/.test(svg), "source should appear once, in the footer");
    assert.ok(!/Not financial advice/.test(svg), "disclaimer belongs in the post text");
    assert.match(svg, /THE TAPE/);
    assert.ok(!/SQUARE DESK|MARKET WIRE/.test(svg), "old brand text must be gone");
  });

  test("escapes feed-supplied text (headline can never break the SVG)", () => {
    const svg = buildNewsCardSvg({ ...opts, headline: 'Exchange hacked <script>&"quote' });
    assert.ok(!svg.includes("<script>"), "raw markup leaked through");
    assert.match(svg, /&lt;script&gt;/);
    assert.ok(svg.startsWith("<svg"), svg.slice(0, 40));
  });

  test("optional sparkline adds a polyline and high/low labels", () => {
    const spark = Array.from({ length: 30 }, (_, i) => ({ p: 100 + Math.sin(i / 3) * 5 - i * 0.4 }));
    const svg = buildNewsCardSvg({ ...opts, sparkline: spark, sparklineLabel: "7-day price" });
    assert.match(svg, /<polyline points="/);
    assert.match(svg, /high\s+·\s+\$[\d.,]+ low/);
    assert.match(svg, /7-day price/);
    assert.ok(!/over the window/.test(svg), "caption filler removed");
    const plain = buildNewsCardSvg(opts);
    assert.ok(!plain.includes("<polyline"));
  });

  test("at most three coin chips are rendered", () => {
    const svg = buildNewsCardSvg({
      ...opts,
      coins: [{ symbol: "$A" }, { symbol: "$B" }, { symbol: "$C" }, { symbol: "$D" }],
    });
    assert.match(svg, /\$A/);
    assert.ok(!svg.includes("$D"), "$D should not appear");
  });
});

describe("alert card", () => {
  test("shows price, change and the range position", () => {
    const svg = buildAlertCardSvg({
      symbol: "$BTC", price: 67420.5, change24h: -4.8,
      low: 65900, high: 71200,
      headline: "Bitcoin sinks below $68,000 as ETF outflows accelerate",
      source: "CoinDesk",
    });
    assert.match(svg, /PRICE ALERT/);
    assert.match(svg, /\$67,421/);
    assert.match(svg, /−4\.8% in 24h/);
    assert.match(svg, /low \$65,900/);
    assert.match(svg, /high \$71,200/);
    assert.match(svg, /sinks below/);
  });

  test("renders without optional numbers (no crash, no range bar)", () => {
    const svg = buildAlertCardSvg({ headline: "Something moved sharply", symbol: "$XYZ" });
    assert.match(svg, /PRICE ALERT/);
    assert.ok(!svg.includes("low $"));
  });
});

describe("explainer slide", () => {
  test("kicker, title, bullets, footer and progress dots", () => {
    const svg = buildExplainerSlideSvg({
      kicker: "EXPLAINER",
      title: "What is total value locked (TVL)?",
      bullets: ["TVL is the value of assets deposited in a protocol", "It is measured in USD at current prices"],
      footer: "Square Desk · Research",
      index: 1, total: 3,
    });
    assert.match(svg, /EXPLAINER/);
    assert.match(svg, /total value locked/);
    assert.match(svg, /deposited in a protocol/);
    assert.match(svg, /Square Desk · Research/);
    // progress dots: 3 circles, one accent-filled (the brand mark's sprocket holes are r="3.6" and don't count)
    const dots = (svg.match(/<circle [^>]*>/g) || []).filter((c) => !/r="3\.6"/.test(c));
    assert.equal(dots.length, 3);
  });

  test("caps bullets at four", () => {
    const svg = buildExplainerSlideSvg({ title: "T", bullets: ["one", "two", "three", "four", "five", "six"] });
    assert.ok(svg.includes("one") && svg.includes("four"));
    assert.ok(!svg.includes(">five<") && !svg.includes(">six<"));
  });
});

describe("charts and grids", () => {
  test("bar chart colours by sign and labels values", () => {
    const svg = buildBarChartSvg({
      title: "24h Change",
      rows: [{ label: "BTC", value: 1.4 }, { label: "SOL", value: -5.6 }],
    });
    assert.match(svg, /24h Change/);
    assert.match(svg, /\+1\.4%/);
    assert.match(svg, /−5\.6%/);
    assert.ok(svg.includes(BRAND.green) && svg.includes(BRAND.red));
  });

  test("stat grid renders up to six tiles with values", () => {
    const svg = buildStatGridSvg({
      title: "DeFi in numbers",
      stats: [
        { label: "DEX volume 24h", value: "$4.2B", sub: "tracked DEXs" },
        { label: "Total TVL", value: "$91B" },
        { label: "Top protocol", value: "Aave", tone: "green" },
      ],
      footer: "Data: DefiLlama",
    });
    assert.match(svg, /DeFi in numbers/);
    assert.match(svg, /\$4\.2B/);
    assert.match(svg, /tracked DEXs/);
    assert.match(svg, /Aave/);
    assert.match(svg, /Data: DefiLlama/);
  });

  test("line chart normalises series and renders legends", () => {
    const svg = buildLineChartSvg({
      title: "DEX volume trend",
      series: [{ name: "Volume", points: [1, 2, 1.5, 3, 2.8, 4] }],
      windowLabel: "Last 7 days",
    });
    assert.match(svg, /<polyline points="/);
    assert.match(svg, /Volume/);
    assert.match(svg, /Last 7 days/);
  });

  test("line chart skips series with too few points", () => {
    const svg = buildLineChartSvg({ title: "T", series: [{ name: "One", points: [1, 2] }, { name: "Bad", points: [1] }] });
    assert.ok(svg.includes("One"));
    assert.ok(!svg.includes("Bad"));
  });

  test("article cover wraps the title and lists coins", () => {
    const svg = buildArticleCoverSvg({ kicker: "RESEARCH", title: "Inside the $201 million buyback that emptied a Solana treasury", coins: [{ symbol: "$SOL", change24h: null }] });
    assert.match(svg, /RESEARCH/);
    assert.match(svg, /Inside the \$201 million/);
    assert.match(svg, /\$SOL/);
  });
});

describe("optional PNG renderer", () => {
  test("returns a PNG buffer when @resvg/resvg-js is installed, null otherwise", async () => {
    const svg = buildExplainerSlideSvg({ title: "Render smoke test", bullets: ["b"] });
    const png = await renderSvgToPng(svg, { scale: 1 });
    // Either the optional dep is present and we get real PNG bytes, or it is
    // absent and we get null. Both are fine; a crash is not.
    if (png === null) {
      assert.equal(png, null);
    } else {
      assert.ok(Buffer.isBuffer(png));
      assert.ok(png.length > 1000);
      // PNG magic bytes.
      assert.equal(png[0], 0x89);
      assert.equal(png[1], 0x50);
    }
  });
});

describe("v11.2 brand mark, avatar and extreme alert card", () => {
  test("avatar is a square SVG built from the brand mark", async () => {
    const { buildAvatarSvg, brandMarkSvg } = await import("../cards.mjs");
    const svg = buildAvatarSvg({ size: 512 });
    assert.match(svg, /width="512" height="512"/);
    assert.ok(svg.includes(brandMarkSvg(0, 0, 1).split("\n")[1]), "avatar uses the shared mark");
  });
  test("extreme card: red for a fall, green for a rise, real line + glow filter", async () => {
    const { buildExtremeAlertCardSvg } = await import("../cards.mjs");
    const spark = Array.from({ length: 30 }, (_, i) => ({ p: 100 - i }));
    const down = buildExtremeAlertCardSvg({ symbol: "$BTC", price: 79000, heroPct: -8.6, sparkline: spark, headline: "H" });
    const up = buildExtremeAlertCardSvg({ symbol: "$SOL", price: 214, heroPct: 9.4, sparkline: spark, headline: "H" });
    assert.match(down, /−8\.6%/);
    assert.match(down, /#F6465D/);
    assert.match(up, /\+9\.4%/);
    assert.match(up, /#0ECB81/);
    assert.match(down, /<filter id="glow"/);
    assert.match(down, /<polyline points="/);
    assert.ok(!/SQUARE DESK|MARKET WIRE/.test(down));
  });
  test("extreme card escapes headline text", async () => {
    const { buildExtremeAlertCardSvg } = await import("../cards.mjs");
    const svg = buildExtremeAlertCardSvg({ symbol: "$X", heroPct: -9, headline: "<script>&" });
    assert.ok(!svg.includes("<script>"));
  });
});

describe("v11.4 candlestick charts and the one-piece T", () => {
  const walk = (n, base = 100) => Array.from({ length: n }, (_, i) => {
    const open = base + Math.sin(i) * 3, close = base + Math.sin(i + 1) * 3;
    return { open, close, high: Math.max(open, close) + 1, low: Math.min(open, close) - 1, volume: 10 + i };
  });

  test("aggregateCandles caps the bar count and keeps true open / close / high / low / volume", () => {
    const raw = walk(96);
    const out = aggregateCandles(raw, 48);
    assert.equal(out.length, 48);
    assert.equal(out[0].open, raw[0].open);
    assert.equal(out[0].close, raw[1].close);
    assert.equal(out[0].high, Math.max(raw[0].high, raw[1].high));
    assert.equal(out[0].low, Math.min(raw[0].low, raw[1].low));
    assert.equal(out[0].volume, raw[0].volume + raw[1].volume);
    assert.equal(aggregateCandles(walk(20), 48).length, 20, "short series are untouched");
  });

  test("aggregateCandles drops junk rows and repairs impossible highs/lows", () => {
    const out = aggregateCandles([{ open: 1, high: 0.5, low: 2, close: 1.5 }, { open: NaN, high: 1, low: 1, close: 1 }, null], 48);
    assert.equal(out.length, 1);
    assert.equal(out[0].high, 1.5);
    assert.equal(out[0].low, 1);
    assert.ok(!hasCandles(walk(7)) && hasCandles(walk(8)));
  });

  test("alert card with candles draws bodies, wicks and volume bars, not a line", () => {
    const svg = buildAlertCardSvg({ symbol: "$BTC", price: 100, change24h: -2, headline: "H", candles: walk(96), level: 98 });
    assert.ok(!svg.includes("<polyline"), "no price line");
    assert.equal((svg.match(/rx="1.5"/g) || []).length, 48 * 2, "48 bodies + 48 volume bars");
    assert.match(svg, /stroke-linecap="round"\/>/);
    assert.match(svg, /high · .* low/);
    assert.match(svg, /stroke-dasharray="10 8"/, "level line still drawn");
    assert.ok(!svg.includes("paint-order"));
  });

  test("candles are green when they close up and red when they close down", () => {
    const svg = buildAlertCardSvg({ symbol: "$X", price: 1, headline: "H", candles: [
      ...Array.from({ length: 4 }, () => ({ open: 1, close: 2, high: 2.5, low: 0.5 })),
      ...Array.from({ length: 4 }, () => ({ open: 2, close: 1, high: 2.5, low: 0.5 })),
    ] });
    assert.equal((svg.match(new RegExp(`<rect[^>]*rx="1.5" fill="${BRAND.green}"`, "g")) || []).length, 4);
    assert.equal((svg.match(new RegExp(`<rect[^>]*rx="1.5" fill="${BRAND.red}"`, "g")) || []).length, 4);
  });

  test("no volume in the data => no volume bars; too few candles => falls back to the line", () => {
    const noVol = walk(30).map(({ volume, ...c }) => c);
    const a = buildAlertCardSvg({ symbol: "$BTC", price: 100, headline: "H", candles: noVol });
    assert.equal((a.match(/rx="1.5"/g) || []).length, 30);
    const spark = Array.from({ length: 12 }, (_, i) => ({ p: 100 + i }));
    const b = buildAlertCardSvg({ symbol: "$BTC", price: 100, headline: "H", candles: walk(3), sparkline: spark });
    assert.match(b, /<polyline points="/);
  });

  test("extreme and news cards take candles too (extreme glows)", () => {
    const e = buildExtremeAlertCardSvg({ symbol: "$BTC", price: 100, heroPct: -9, headline: "H", candles: walk(48) });
    assert.ok(!e.includes("<polyline"));
    assert.match(e, /<g filter="url\(#glow\)"/);
    const n = buildNewsCardSvg({ headline: "Ethereum staking inflows hit a record high", source: "CoinDesk", candles: walk(40) });
    assert.ok(!n.includes("<polyline"));
    assert.equal((n.match(/rx="1.5"/g) || []).length, 40, "news cards skip the volume strip");
  });

  test("candle cards are deterministic and escape nothing they should not need to", () => {
    const o = { symbol: "$BTC", price: 100, headline: "H", candles: walk(48), level: 99 };
    assert.equal(buildAlertCardSvg(o), buildAlertCardSvg(o));
  });

  test("the T is a single outline: one path, no separate stem rectangle", () => {
    const svg = brandMarkSvg(0, 0, 100);
    assert.equal((svg.match(/<path /g) || []).length, 1);
    assert.ok(!/<rect/.test(svg), "no stacked rectangles that could read as an 'I'");
    assert.equal((svg.match(/<circle/g) || []).length, 5, "five tape holes");
  });
});
