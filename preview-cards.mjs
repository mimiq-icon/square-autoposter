// preview-cards.mjs — draws sample cards to ./card-previews/ so you can look at
// them without posting anything. No network, no keys.
//   node preview-cards.mjs
import fs from "node:fs";
import { buildNewsCardSvg, buildAlertCardSvg, buildExtremeAlertCardSvg, renderSvgToPng } from "./cards.mjs";

const wave = (n, start, end, wobble) => Array.from({ length: n }, (_, i) => {
  const t = i / (n - 1);
  return { p: start + (end - start) * t + Math.sin(i * 0.9) * wobble + Math.sin(i * 0.31) * wobble * 0.6 };
});

// Deterministic OHLC candles that walk from `start` to `end` (no randomness, so
// previews are stable between runs). Volume swells on the big candles.
const candleWalk = (n, start, end, wobble) => {
  const out = [];
  let prev = start;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / n;
    const close = start + (end - start) * t + Math.sin(i * 1.7) * wobble + Math.sin(i * 0.53) * wobble * 0.8;
    const open = prev;
    const up = Math.abs(Math.sin(i * 2.3)) * wobble * 0.7, dn = Math.abs(Math.cos(i * 1.9)) * wobble * 0.7;
    out.push({ open, close, high: Math.max(open, close) + up, low: Math.min(open, close) - dn, volume: 40 + Math.abs(close - open) * (400 / wobble) + Math.abs(Math.sin(i)) * 30 });
    prev = close;
  }
  return out;
};

const cards = {
  "news-short": buildNewsCardSvg({
    headline: "SkyAI sells off entire Solana treasury as it launches $201 million buyback",
    source: "The Block, Cointelegraph",
    coins: [{ symbol: "$SOL", change24h: -3.4 }, { symbol: "$BTC", change24h: -1.2 }],
  }),
  "news-long": buildNewsCardSvg({
    headline: "SEC delays decision on several spot altcoin ETF applications, citing the need for more public comment before it can rule",
    source: "Cointelegraph",
    coins: [{ symbol: "$ETH", change24h: 0.8 }],
  }),
  "news-chart": buildNewsCardSvg({
    headline: "Ethereum staking inflows hit a record high",
    source: "CoinDesk",
    coins: [{ symbol: "$ETH", change24h: 2.1 }],
    candles: candleWalk(40, 2400, 2610, 30),
  }),
  "alert-chart": buildAlertCardSvg({
    symbol: "$BTC", price: 82950, change24h: -1.2, low: 81900, high: 84100,
    headline: "Bitcoin drops below $83,000 and now trades at $82,950",
    source: "", level: 83000,
    candles: candleWalk(48, 84000, 82950, 140), sparklineLabel: "24h",
  }),
  "extreme-down": buildExtremeAlertCardSvg({
    symbol: "$BTC", price: 79450, heroPct: -8.6, heroLabel: "in 24h",
    headline: "Bitcoin plunges below $80,000 as liquidations spread", source: "", level: 80000,
    candles: candleWalk(48, 86900, 79450, 380),
  }),
  "extreme-up": buildExtremeAlertCardSvg({
    symbol: "$SOL", price: 214.3, heroPct: 9.4, heroLabel: "in 24h",
    headline: "Solana surges past $210 and leads the majors", source: "", level: 210,
    candles: candleWalk(48, 196, 214.3, 3),
  }),
  "alert-line-fallback": buildAlertCardSvg({
    symbol: "$BTC", price: 82950, change24h: -1.2, low: 81900, high: 84100,
    headline: "Same card when only closing prices are available", source: "", level: 83000,
    sparkline: wave(48, 84000, 82950, 150),
  }),
  "alert-nochart": buildAlertCardSvg({
    symbol: "$ETH", price: 3120.5, change24h: 5.4, low: 2960, high: 3150,
    headline: "Ethereum jumps 5.4% in 24 hours", source: "",
  }),
};

fs.mkdirSync("card-previews", { recursive: true });
for (const [name, svg] of Object.entries(cards)) {
  fs.writeFileSync(`card-previews/${name}.svg`, svg);
  const png = await renderSvgToPng(svg, { scale: 1 });
  if (png) { fs.writeFileSync(`card-previews/${name}.png`, png); console.log(`wrote card-previews/${name}.png`); }
  else console.log(`wrote card-previews/${name}.svg (PNG renderer missing: npm install --no-save @resvg/resvg-js)`);
}
