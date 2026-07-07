// post.mjs  (v3 — upgraded)
// ============================================================================
// Fetches live crypto data from MULTIPLE free, no-key sources and posts to
// Binance Square with $cashtags.
//
// What's new in v3 (vs v2):
//   - BUG FIX: Text posts now explicitly send `contentType: 1`. Without it,
//     Binance was treating posts as articles and only showing the first line
//     (~6 words). All weekday text posts now publish correctly in full.
//   - NEW: Weekly ARTICLE post on Sundays — long-form weekly recap with title,
//     markdown body, and the 7-day chart embedded as cover image. Falls back
//     to chart-only post, then text weekly recap, on any failure.
//   - NEW: Length guard — any text post over 1500 chars is auto-shortened by
//     trimming trailing lines until under limit. Prevents silent truncation.
//
// What was new in v2 (preserved):
//   - 4 additional free data sources (no API keys, no cost):
//       * CoinGecko /search/trending  — what coins people are searching for
//       * CoinGecko /global           — total market cap, BTC dominance, volume
//       * Alternative.me Fear & Greed — 0-100 market sentiment score
//       * Binance /api/v3/ticker/24hr — scans ~30 well-known coins for big moves
//   - 4 new content templates: Macro Overview, Anomaly Radar, Trending Today,
//     Market Sentiment
//   - Smart template selection: Anomaly > Extreme Sentiment > Rotation
//
// What DID NOT change (deliberately):
//   - Same $0 / no-PC / mobile-only architecture (GitHub Actions + this file).
//   - Same daily-post.yml workflow — no workflow change needed.
//   - Same GitHub secrets (BINANCE_SQUARE_OPENAPI_KEY, optional GEMINI_API_KEY).
//   - Same Binance Square API endpoints and official upload flow.
//   - Same MAX_CASHTAGS_PER_POST = 3 limit (Binance error 220095).
//   - Same banned-phrases list and AI safety validation.
//   - Same fallback philosophy: if anything fails, post *something* rather
//     than skip a day.
//
// Requires: Node.js 18+ (built-in fetch). No npm install needed.
// Required env var: BINANCE_SQUARE_OPENAPI_KEY
// Optional env var: GEMINI_API_KEY (free at aistudio.google.com/apikey)
// ============================================================================

import fs from "fs";
import os from "os";
import path from "path";

// ---------------------------------------------------------------------------
// Core watchlist — the 5 coins used by snapshot/mover/educational/weekly
// templates. Edit this to change what your "default" rotation covers.
// ---------------------------------------------------------------------------
const COINS = [
  { id: "bitcoin", symbol: "BTC" },
  { id: "ethereum", symbol: "ETH" },
  { id: "binancecoin", symbol: "BNB" },
  { id: "solana", symbol: "SOL" },
  { id: "ripple", symbol: "XRP" },
  { id: "cardano", symbol: "ADA" },
  { id: "dogecoin", symbol: "DOGE" },
  { id: "chainlink", symbol: "LINK" },
];

// Binance rejected a post with 5 cashtags (error 220095: "Coin pair count
// exceeds the allowed limit"). Keep every post at or under this number.
const MAX_CASHTAGS_PER_POST = 3;

// ---------------------------------------------------------------------------
// NEW (v2): Extended watchlist for the Anomaly Radar template.
// These are Binance-listed tickers the script scans for unusual 24h moves.
// Kept to ~30 well-known coins so cashtags always resolve to tradeable pairs.
// Add or remove tickers here freely — the scan just won't find coins that
// aren't on this list.
// ---------------------------------------------------------------------------
const ANOMALY_WATCHLIST = new Set([
  "BTC", "ETH", "BNB", "SOL", "XRP", "ADA", "AVAX", "DOGE", "DOT", "LINK",
  "LTC", "BCH", "UNI", "ATOM", "XLM", "NEAR", "APT", "FIL", "ARB", "OP",
  "INJ", "SUI", "TIA", "SEI", "RUNE", "AAVE", "MKR", "PEPE", "SHIB", "TON",
]);

// A coin needs |24h change| >= this to qualify as an "anomaly".
// 10% is a reasonable threshold — high enough to filter noise, low enough
// that something is usually happening on any given day.
const ANOMALY_THRESHOLD_PCT = 10;

// Fear & Greed extremes — the Market Sentiment template only fires when the
// index is at one of these extremes, so it doesn't post every day.
const EXTREME_FEAR_THRESHOLD = 20;   // <= 20 = extreme fear
const EXTREME_GREED_THRESHOLD = 80;  // >= 80 = extreme greed

// NEW (v3): Maximum character length for text posts. Binance Square's display
// has a practical limit around 1500 chars before truncation becomes noticeable.
// The length guard trims trailing lines (keeping the opening hook + cashtags)
// if a template exceeds this. Set to Infinity to disable the guard.
const MAX_POST_LENGTH = 1500;

// NEW (v3): Binance Square content type codes (from the official skill repo).
//   1 = text post (short-form, like a tweet — uses bodyTextOnly)
//   2 = article (long-form, with title + markdown body — uses title + content)
// The original v1/v2 script omitted contentType for text posts, which caused
// Binance to default to article mode and display only the first line.
const CONTENT_TYPE_TEXT = 1;
const CONTENT_TYPE_ARTICLE = 2;

// ---------------------------------------------------------------------------
// Binance Square OpenAPI (official endpoints, vendored from Binance's own
// published skill: github.com/binance/binance-skills-hub)
// ---------------------------------------------------------------------------
const SQUARE_BASE_V1 = "https://www.binance.com/bapi/composite/v1/public/pgc/openApi";
const SQUARE_BASE_V2 = "https://www.binance.com/bapi/composite/v2/public/pgc/openApi";
const IMAGE_POLL_INTERVAL_MS = 3000;
const IMAGE_MAX_POLL_RETRIES = 10;

// Free-tier-eligible Gemini model as of 2026.
// v3.3 FIX: Switched default model from gemini-2.5-flash to gemini-2.0-flash.
// 2.5-flash is a "thinking" model — it burns tokens on internal reasoning
// before generating output, and those thinking tokens count against
// maxOutputTokens. The model would think for ~480 tokens, start writing,
// hit the 500-token ceiling after 40 chars, and get cut off — producing
// the fragments you saw ("Here's a look at some trending crypto assets").
// 2.0-flash doesn't have thinking, so all tokens go to output.
// Override with GEMINI_MODEL env var if you want a different model.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// ---------------------------------------------------------------------------
// v4: MULTI-PROVIDER AI CHAIN
// ---------------------------------------------------------------------------
// The Writer stage now tries multiple AI providers in order, falling back
// on ANY failure (rate limit, network error, validation failure, etc.).
//
// Provider order (first to last):
//   1. Groq       — free, fast, Llama 3.3 70B. Primary.
//   2. OpenRouter — free models available (Llama, Gemini, Mistral via one API). Fallback.
//   3. Gemini     — free, was flaky. Last resort.
//   4. Template   — if all AI providers fail (existing fallback, unchanged).
//
// Each provider is independent. Set only the secrets you have. If you only
// have GROQ_API_KEY, only Groq is tried (then template fallback). If you
// have all three, they're tried in order until one succeeds.
//
// Optional model overrides via env vars:
//   GROQ_MODEL         (default: llama-3.3-70b-versatile)
//   OPENROUTER_MODEL   (default: meta-llama/llama-3.3-70b-instruct:free)
//   GEMINI_MODEL       (default: gemini-2.0-flash)
// ---------------------------------------------------------------------------
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";
// OpenRouter default: free Llama 3.3 70B. Other free options:
//   "google/gemini-2.0-flash-exp:free"
//   "mistralai/mistral-7b-instruct:free"
//   "meta-llama/llama-3.1-8b-instruct:free"
// Browse all at openrouter.ai/models (filter for "free")
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";

// Provider chain — order matters. Groq first (free + fast), OpenRouter second
// (free models via aggregator), Gemini last (free but was problematic).
const AI_PROVIDERS = [
  {
    name: "groq",
    envKey: "GROQ_API_KEY",
    model: GROQ_MODEL,
    callFn: (prompt, key, model) => callOpenAICompatible(prompt, key, model, GROQ_BASE_URL),
  },
  {
    name: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    model: OPENROUTER_MODEL,
    callFn: (prompt, key, model) => callOpenAICompatible(prompt, key, model, OPENROUTER_BASE_URL),
  },
  {
    name: "gemini",
    envKey: "GEMINI_API_KEY",
    model: GEMINI_MODEL,
    callFn: (prompt, key, model) => callGemini(prompt, key, model),
  },
];

// Free, no-key chart rendering service (quickchart.io).
const QUICKCHART_ENDPOINT = "https://quickchart.io/chart";

// ---------------------------------------------------------------------------
// NEW (v2): Free data source endpoints (all no-key, all $0).
// ---------------------------------------------------------------------------
const COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets";
const COINGECKO_TRENDING_URL = "https://api.coingecko.com/api/v3/search/trending";
const COINGECKO_GLOBAL_URL = "https://api.coingecko.com/api/v3/global";
const FEAR_GREED_URL = "https://api.alternative.me/fng/?limit=1";
const BINANCE_TICKER_URL = "https://api.binance.com/api/v3/ticker/24hr";

// ---------------------------------------------------------------------------
// Phrases that turn a factual update into an implicit trading suggestion.
// This matters more here than in typical content: the "Write to Earn" model
// pays a commission specifically when readers trade off a cashtag, so any
// nudge toward buying/selling is a conflict of interest, not just a style
// choice. Kept intentionally broad/blunt — better to over-reject into the
// safe template fallback than let a nudge through.
// ---------------------------------------------------------------------------
const BANNED_PHRASES = [
  "buy the dip", "buying opportunity", "who's buying", "who is buying",
  "good entry", "entry point", "target price", "price target",
  "about to explode", "guaranteed", "guarantee", "sure thing",
  "breakout incoming", "short squeeze", "load up", "your play",
  "financial advice to buy", "should you buy", "should you sell",
  "sell now", "buy now", "moon", "to the moon", "100x", "get in now",
];

// ===========================================================================
// DATA FETCHERS
// ===========================================================================

async function getMarketData({ sparkline = false } = {}) {
  const ids = COINS.map((c) => c.id).join(",");
  const sparklineParam = sparkline ? "&sparkline=true" : "";
  const url = `${COINGECKO_MARKETS_URL}?vs_currency=usd&ids=${ids}&price_change_percentage=24h,7d${sparklineParam}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko markets error: ${res.status}`);
  const rows = await res.json();

  const byId = {};
  for (const row of rows) byId[row.id] = row;

  return COINS.map((c) => {
    const d = byId[c.id];
    if (!d) return null;
    return {
      symbol: c.symbol,
      price: d.current_price,
      change24h: d.price_change_percentage_24h_in_currency,
      change7d: d.price_change_percentage_7d_in_currency,
      sparkline7d: d.sparkline_in_7d?.price || null,
      // v5: CoinGecko already returns these fields on every /coins/markets
      // call — they were being fetched and thrown away. Capturing them
      // gives the writer stage (template or AI) real extra data points to
      // work with (volume, market cap, rank, 24h range) instead of just
      // price + one percentage.
      volume24h: d.total_volume,
      marketCap: d.market_cap,
      rank: d.market_cap_rank,
      high24h: d.high_24h,
      low24h: d.low_24h,
      athChangePct: d.ath_change_percentage,
    };
  }).filter(Boolean);
}

// NEW (v2): Trending coins from CoinGecko. Returns the top searched coins,
// filtered to those with market_cap_rank <= 100 so cashtags always resolve
// to real, tradeable, well-known assets (not obscure micro-caps that might
// not even be on Binance).
async function getTrendingCoins() {
  const res = await fetch(COINGECKO_TRENDING_URL);
  if (!res.ok) throw new Error(`CoinGecko trending error: ${res.status}`);
  const data = await res.json();
  return (data.coins || [])
    .map((c) => c.item)
    .filter((c) => c.market_cap_rank && c.market_cap_rank <= 100)
    .slice(0, 5)
    .map((c) => ({
      symbol: c.symbol.toUpperCase(),
      name: c.name,
      rank: c.market_cap_rank,
    }));
}

// NEW (v2): Global market data from CoinGecko. Total market cap, 24h volume,
// BTC/ETH dominance, and 24h market cap change.
async function getGlobalMarket() {
  const res = await fetch(COINGECKO_GLOBAL_URL);
  if (!res.ok) throw new Error(`CoinGecko global error: ${res.status}`);
  const data = await res.json();
  return {
    totalMcap: data.data.total_market_cap.usd,
    totalVolume: data.data.total_volume.usd,
    btcDominance: data.data.market_cap_percentage.btc,
    ethDominance: data.data.market_cap_percentage.eth,
    mcapChange24h: data.data.market_cap_change_percentage_usd,
  };
}

// NEW (v2): Fear & Greed Index from alternative.me. A single 0-100 score
// where 0 = extreme fear, 100 = extreme greed. Free, no key, no signup.
async function getFearGreed() {
  const res = await fetch(FEAR_GREED_URL);
  if (!res.ok) throw new Error(`Fear & Greed error: ${res.status}`);
  const data = await res.json();
  const fng = data.data[0];
  return {
    value: parseInt(fng.value),
    classification: fng.value_classification, // "Extreme Fear" | "Fear" | "Neutral" | "Greed" | "Extreme Greed"
  };
}

// NEW (v2): Scans Binance's public 24h ticker endpoint for unusual moves.
// Fetches ALL USDT pairs, filters to ANOMALY_WATCHLIST, returns those with
// |24h change| >= ANOMALY_THRESHOLD_PCT, sorted by absolute move.
// Note: this endpoint returns ~1MB of JSON. It's the heaviest call in the
// script but still well within GitHub Actions' execution limits.
async function getBinanceAnomalies() {
  const res = await fetch(BINANCE_TICKER_URL);
  if (!res.ok) throw new Error(`Binance ticker error: ${res.status}`);
  const all = await res.json();
  return all
    .filter((t) => t.symbol.endsWith("USDT"))
    .map((t) => ({
      symbol: t.symbol.slice(0, -4),
      price: parseFloat(t.lastPrice),
      changePct: parseFloat(t.priceChangePercent),
      volume: parseFloat(t.quoteVolume),
    }))
    .filter((t) => ANOMALY_WATCHLIST.has(t.symbol) && Math.abs(t.changePct) >= ANOMALY_THRESHOLD_PCT)
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
    .slice(0, 5);
}

// ===========================================================================
// FORMAT HELPERS
// ===========================================================================

function fmtPct(n) {
  if (n === null || n === undefined) return "n/a";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtPrice(n) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 4 : 2 })}`;
}

// NEW (v2): Format large USD amounts as $X.XXB or $X.XXT for readability.
function fmtMcap(n) {
  if (n === null || n === undefined) return "n/a";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  return `$${n.toLocaleString()}`;
}

function rotateSubset(list, size, offset) {
  const out = [];
  for (let i = 0; i < size && i < list.length; i++) {
    out.push(list[(offset + i) % list.length]);
  }
  return out;
}

// ===========================================================================
// TEMPLATE BUILDERS
// ---------------------------------------------------------------------------
// Existing templates (unchanged): snapshot, mover, educational, weekly recap,
// weekly image caption.
// New templates (v2): macro overview, anomaly radar, trending today,
// market sentiment.
// Every template returns a string, or null if it can't be built (e.g.,
// missing data). main() handles the null case by falling back.
// ===========================================================================

function buildSnapshotPost(data, dayIndex) {
  const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
  // v5: Added 7d change + 24h volume alongside price/24h change — the
  // template was down to 2 numbers per coin, thinner than what's now
  // available from getMarketData().
  const lines = featured.map(
    (d) => `$${d.symbol}: ${fmtPrice(d.price)} (${fmtPct(d.change24h)} 24h, ${fmtPct(d.change7d)} 7d) \u2014 vol ${fmtMcap(d.volume24h)}`
  );
  return [
    "\uD83D\uDCCA Crypto Market Snapshot",
    ...lines,
    "",
    "Which one are you watching today? Not financial advice \u2014 always DYOR.",
  ].join("\n");
}

function buildTopMoverPost(data) {
  let best = null;
  for (const d of data) {
    if (!best || Math.abs(d.change24h) > Math.abs(best.change24h)) best = d;
  }
  if (!best) return null;
  const direction = best.change24h >= 0 ? "up" : "down";
  // v5: Added 24h range (high/low) and volume — gives a concrete sense of
  // how big the move was relative to the day's range, not just a percent.
  const rangeLine = (best.low24h && best.high24h)
    ? `24h range: ${fmtPrice(best.low24h)} \u2013 ${fmtPrice(best.high24h)}. Volume: ${fmtMcap(best.volume24h)}.`
    : `Volume: ${fmtMcap(best.volume24h)}.`;
  return [
    `\uD83D\uDC40 Today's biggest mover: $${best.symbol}`,
    `Price: ${fmtPrice(best.price)} \u2014 ${direction} ${Math.abs(best.change24h).toFixed(2)}% in 24h.`,
    rangeLine,
    "",
    "Market data only, not a trade signal. Always DYOR.",
  ].join("\n");
}

const EDU_TIPS = [
  "Market cap = price \u00d7 circulating supply. It values the coins already out there, not future issuance.",
  "Fully diluted valuation (FDV) assumes max possible supply exists today. A big gap between market cap and FDV usually means more tokens unlock over time.",
  "24h volume shows how much changed hands in a day \u2014 a rough interest gauge, not a guarantee of where price goes next.",
  "Circulating supply isn't fixed for every asset \u2014 minting, burning, and vesting unlocks can all change it over time.",
  "Volatility cuts both ways: the same trait that enables fast gains enables fast losses. Position sizing matters more than most people think.",
  "Hash rate and mining difficulty rise and fall with miner confidence \u2014 they're slower-moving signals than price, but they show long-term network health.",
  "Funding rates on perpetual futures tilt positive when longs pay shorts, and negative when shorts pay longs. The sign tells you which side is more leveraged, not which side is right.",
  "Open interest is the total notional of outstanding derivative contracts. Rising price + falling OI can mean short covering; rising price + rising OI often means new money entering.",
];

function buildEducationalPost(data, dayIndex) {
  const tip = EDU_TIPS[dayIndex % EDU_TIPS.length];
  const coin = data[dayIndex % data.length];
  return [
    "\uD83D\uDCA1 Quick crypto concept",
    tip,
    "",
    `Currently watching $${coin.symbol} at ${fmtPrice(coin.price)}.`,
    "Education, not financial advice.",
  ].join("\n");
}

function buildWeeklyRecapPost(data, dayIndex) {
  const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
  const lines = featured.map(
    (d) => `$${d.symbol}: ${fmtPrice(d.price)} (${fmtPct(d.change7d)} this week)`
  );
  return [
    "\uD83D\uDCC5 Weekly Crypto Recap",
    ...lines,
    "",
    "7-day view, not a forecast. Always DYOR.",
  ].join("\n");
}

function buildWeeklyImageCaption(featured) {
  const tags = featured.map((d) => `$${d.symbol}`).join(" ");
  return [
    "\uD83D\uDCC8 7-day chart: " + tags,
    "Normalized % change so different price scales are easy to compare at a glance.",
    "",
    "Chart only, not a forecast. Always DYOR.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// NEW (v2): Macro Overview — total market cap, BTC dominance, 24h change,
// optional sentiment, plus 2 featured coins from the core watchlist.
// Uses only 2 cashtags so there's room for the macro context lines.
// ---------------------------------------------------------------------------
function buildMacroOverviewPost(data, dayIndex, globalMarket, fng) {
  const featured = rotateSubset(data, 2, dayIndex);
  const coinLines = featured.map(
    (d) => `$${d.symbol}: ${fmtPrice(d.price)} (${fmtPct(d.change24h)} 24h)`
  );
  const sentimentLine = fng
    ? `Market sentiment: ${fng.classification} (${fng.value}/100).`
    : null;
  return [
    "\uD83C\uDF10 Macro Market Overview",
    `Total cap: ${fmtMcap(globalMarket.totalMcap)} (${fmtPct(globalMarket.mcapChange24h)} 24h).`,
    `BTC dominance: ${globalMarket.btcDominance.toFixed(1)}%. 24h volume: ${fmtMcap(globalMarket.totalVolume)}.`,
    sentimentLine,
    "",
    "Featured:",
    ...coinLines,
    "",
    "State of the market, not a forecast. Always DYOR.",
  ].filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// NEW (v2): Anomaly Radar — top 3 unusual 24h moves from the Binance scan.
// Each anomaly gets a cashtag. Direction is stated factually; no "buy the
// dip" or "selling opportunity" language.
// ---------------------------------------------------------------------------
function buildAnomalyRadarPost(anomalies) {
  if (!anomalies || anomalies.length === 0) return null;
  const top3 = anomalies.slice(0, MAX_CASHTAGS_PER_POST);
  const lines = top3.map((a) => {
    const direction = a.changePct >= 0 ? "up" : "down";
    return `$${a.symbol}: ${direction} ${Math.abs(a.changePct).toFixed(1)}% in 24h (vol ${fmtMcap(a.volume)}).`;
  });
  return [
    "\uD83D\uDEA8 Anomaly Radar \u2014 unusual 24h moves",
    ...lines,
    "",
    "Notable moves, not trade signals. Always DYOR.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// NEW (v2): Trending Today — top 3 trending coins from CoinGecko, filtered
// to those with market cap rank <= 100 (so cashtags resolve to real Binance
// pairs). States names and ranks factually; no hype language.
// ---------------------------------------------------------------------------
function buildTrendingTodayPost(trending) {
  if (!trending || trending.length === 0) return null;
  const top3 = trending.slice(0, MAX_CASHTAGS_PER_POST);
  const lines = top3.map((t) => `$${t.symbol} (${t.name}) \u2014 rank #${t.rank}.`);
  return [
    "\uD83D\uDD25 Trending Today",
    "Top searched coins on CoinGecko right now:",
    ...lines,
    "",
    "Trending \u2260 recommendation. Always DYOR.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// NEW (v2): Market Sentiment — only fires when Fear & Greed is at an extreme
// (<= 20 extreme fear, or >= 80 extreme greed). Reports the reading and what
// it tends to coincide with historically, without framing it as a trade
// signal. Includes one featured coin's price as a concrete reference point.
// ---------------------------------------------------------------------------
function buildMarketSentimentPost(fng, data, dayIndex) {
  if (!fng) return null;
  const isExtremeFear = fng.value <= EXTREME_FEAR_THRESHOLD;
  const isExtremeGreed = fng.value >= EXTREME_GREED_THRESHOLD;
  if (!isExtremeFear && !isExtremeGreed) return null;

  const context = isExtremeFear
    ? "Extreme fear often coincides with capitulation and high volatility \u2014 it's a sentiment reading, not a buy or sell signal by itself."
    : "Extreme greed often coincides with euphoria and high participation \u2014 it's a sentiment reading, not a buy or sell signal by itself.";

  const coin = data[dayIndex % data.length];
  return [
    `\uD83D\uDCA8 Market Sentiment: ${fng.classification} (${fng.value}/100)`,
    context,
    "",
    `Watching $${coin.symbol} at ${fmtPrice(coin.price)} (${fmtPct(coin.change24h)} 24h).`,
    "",
    "Sentiment reading, not financial advice. Always DYOR.",
  ].join("\n");
}

// ===========================================================================
// AI MODE (optional) — only runs if GEMINI_API_KEY is set.
// ===========================================================================

function countCashtags(text) {
  const matches = text.match(/\$[A-Z]{2,6}\b/g) || [];
  return matches;
}

// v4.3: Full names for the core watchlist, used to catch the model naming a
// coin in plain prose (e.g. "Bitcoin," "Ethereum") that isn't actually in
// today's DATA/allowedSymbols. This is a different failure mode than extra
// cashtags: no "$" prefix, so countCashtags() never sees it, but it's still
// an ungrounded claim about a coin the post has no real data for. Caught this
// class of bug via the example prompts ("...ETH and BNB drift sideways")
// priming the model to reuse those names even when today's featured coins
// were different — same root cause as the cashtag-copying issue, just
// showing up as a bare word instead of a $cashtag.
const COIN_NAMES_BY_SYMBOL = {
  BTC: ["bitcoin"],
  ETH: ["ethereum"],
  BNB: ["bnb", "binance coin", "binancecoin"],
  SOL: ["solana"],
  XRP: ["ripple", "xrp"],
  ADA: ["cardano"],
  DOGE: ["dogecoin"],
  LINK: ["chainlink"],
};

function findUngroundedCoinName(text, allowedSymbols) {
  const lower = text.toLowerCase();
  for (const [symbol, names] of Object.entries(COIN_NAMES_BY_SYMBOL)) {
    if (allowedSymbols.includes(symbol)) continue; // grounded — fine to mention
    for (const name of names) {
      const re = new RegExp(`\\b${name}\\b`, "i");
      if (re.test(lower)) return { symbol, name };
    }
  }
  return null;
}

// v4.4: Refactored to return a result object instead of a bare boolean.
// This lets the caller (callAiWithFallback) distinguish between failures
// that a corrective retry can fix (cashtag overcount, ungrounded name)
// and failures that a retry won't help (banned phrase, filler, length,
// missing DYOR). Retryable failures get one corrective retry per provider
// with a sharper nudge showing the model exactly what it did wrong.
//
// Returns:
//   { ok: true }                                          — post is safe to publish
//   { ok: false, reason: "...", retryable: true/false }   — post rejected
//
// retryable = true means: a corrective retry (showing the model the reason)
// might fix it. retryable = false means: the failure is structural (banned
// phrase, filler habit, length) and a retry with the same provider is
// unlikely to help — move to the next provider.
function isSafeAiText(text, allowedSymbols) {
  if (!text || typeof text !== "string") {
    return { ok: false, reason: "empty or non-string output", retryable: false };
  }
  const trimmed = text.trim();

  // v4.5: Lowered minimum from 120 to 100 chars. The 120 threshold was
  // killing complete posts for being 1 char under an arbitrary line (the
  // corrective retry produced 119 chars and got rejected). 100 still
  // catches the 44-char fragments from v3 but doesn't reject a real post
  // for off-by-one length.
  if (trimmed.length < 100) {
    return { ok: false, reason: `too short (${trimmed.length} chars, need >= 100)`, retryable: false };
  }
  if (trimmed.length > 600) {
    return { ok: false, reason: `too long (${trimmed.length} chars, max 600)`, retryable: false };
  }

  // v4.5: Cashtag checks now count UNIQUE symbols, not total matches.
  // Binance's error 220095 is about "coin pair count" (unique coins),
  // not total $-mentions. A post that says "$BNB at $576, $BNB still
  // leading" has 2 cashtag matches but only 1 unique coin — that's fine
  // for Binance. Previously this was over-counted as 2 cashtags.
  const tags = countCashtags(trimmed);
  const uniqueSymbols = [...new Set(tags.map(t => t.slice(1)))];

  if (uniqueSymbols.length === 0) {
    return {
      ok: false,
      reason: `no cashtags — must use at least 1 of: ${allowedSymbols.map(s => "$" + s).join(", ")}`,
      retryable: true,
    };
  }
  if (uniqueSymbols.length > MAX_CASHTAGS_PER_POST) {
    return {
      ok: false,
      reason: `used ${uniqueSymbols.length} unique coins (${[...new Set(tags)].join(", ")}), max is ${MAX_CASHTAGS_PER_POST}. Use ONLY these: ${allowedSymbols.map(s => "$" + s).join(", ")}`,
      retryable: true,
    };
  }
  const ungroundedSymbols = uniqueSymbols.filter(s => !allowedSymbols.includes(s));
  if (ungroundedSymbols.length > 0) {
    return {
      ok: false,
      reason: `used cashtag(s) not in today's data: ${ungroundedSymbols.map(s => "$" + s).join(", ")}. Use ONLY these: ${allowedSymbols.map(s => "$" + s).join(", ")}`,
      retryable: true,
    };
  }

  // Ungrounded coin names (bare words, no $) — also retryable.
  const ungrounded = findUngroundedCoinName(trimmed, allowedSymbols);
  if (ungrounded) {
    return {
      ok: false,
      reason: `named "${ungrounded.name}" (${ungrounded.symbol}) which isn't in today's data. Only mention: ${allowedSymbols.join(", ")}`,
      retryable: true,
    };
  }

  // Must contain the DYOR closing line — not retryable, this is a hard
  // structural requirement the model should always meet.
  const lower = trimmed.toLowerCase();
  if (!lower.includes("dyor") && !lower.includes("not financial advice")) {
    return { ok: false, reason: "missing DYOR/not-financial-advice line", retryable: false };
  }

  // Filler phrase detection — not retryable. If the model defaults to
  // filler, a retry usually produces different filler.
  const FILLER_PHRASES = [
    "making appearances",
    "continues to see",
    "needs no introduction",
    "it's worth noting",
    "it is worth noting",
    "worth mentioning",
    "maintaining its position",
    "holding steady at rank",
    "with their respective",
    "making waves",
    "gaining traction",
    "catching attention",
    "drawing attention",
    "turning heads",
    "in the spotlight",
    "under the spotlight",
    "stands out as",
    "remains a key",
    "remains a focal",
  ];
  for (const phrase of FILLER_PHRASES) {
    if (lower.includes(phrase)) {
      return { ok: false, reason: `filler phrase "${phrase}"`, retryable: false };
    }
  }

  // Banned phrases (trading suggestions) — not retryable.
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      return { ok: false, reason: `banned phrase "${phrase}"`, retryable: false };
    }
  }

  return { ok: true };
}

// v4.4 NEW: Builds a corrective retry prompt that shows the model exactly
// what it did wrong on the first attempt, then asks it to fix it.
// Only called when isSafeAiText returned retryable: true.
function buildCorrectivePrompt(originalPrompt, failedOutput, reason) {
  return [
    "Your previous attempt was rejected. Here's what went wrong:",
    "",
    `FAILED OUTPUT:`,
    failedOutput,
    "",
    `REASON FOR REJECTION: ${reason}`,
    "",
    "Write the post again, fixing the issue above. Keep everything else the same — same data, same style, same 2-3 sentence density.",
    "",
    "ORIGINAL INSTRUCTIONS (for reference):",
    originalPrompt,
  ].join("\n");
}

// v4: Updated to accept key and model params so it matches the provider
// interface. When called directly (old behavior), falls back to env vars.
async function callGemini(prompt, key, model) {
  key = key || process.env.GEMINI_API_KEY;
  model = model || GEMINI_MODEL;
  if (!key) return null;

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

  // gemini-2.5-* models are "thinking" models that burn tokens on internal
  // reasoning. If using a 2.5 model, disable thinking via thinkingConfig.
  const isThinkingModel = model.includes("2.5");
  const generationConfig = {
    maxOutputTokens: 800,
    temperature: 0.4,
    topP: 0.9,
  };
  if (isThinkingModel) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const res = await fetch(`${endpoint}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Gemini HTTP ${res.status}: ${errBody.substring(0, 200)}`);
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];

  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    throw new Error(`Gemini finishReason: ${finishReason}`);
  }

  return candidate?.content?.parts?.[0]?.text || null;
}

// v4 NEW: OpenAI-compatible API caller. Works for both Groq and OpenAI
// (they use the same chat completions format, just different base URLs).
// Throws on any error so the caller can catch and fall back to next provider.
async function callOpenAICompatible(prompt, key, model, baseUrl) {
  if (!key) return null;

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 800,
      temperature: 0.4,
      top_p: 0.9,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`${model} HTTP ${res.status}: ${errBody.substring(0, 200)}`);
  }

  const data = await res.json();
  const choice = data?.choices?.[0];
  if (!choice) throw new Error("No choices in response");

  // Check finish_reason. "stop" is normal; "length" = hit max_tokens;
  // "content_filter" = safety filter triggered. Reject anything != "stop".
  const finishReason = choice.finish_reason;
  if (finishReason && finishReason !== "stop") {
    throw new Error(`${model} finish_reason: ${finishReason}`);
  }

  return choice.message?.content || null;
}

// v4.4: Try each AI provider in order. Returns { text, provider } on
// success, or null if all providers fail or return invalid output.
//
// NEW in v4.4: One corrective retry per provider when validation fails
// on something retryable (cashtag overcount, ungrounded name). The retry
// shows the model exactly what it did wrong, which is more effective than
// rewording the prompt after every failure.
//
// Retry only happens when isSafeAiText returns retryable: true. Network
// errors, rate limits (429), and non-retryable validation failures (banned
// phrases, filler, length, missing DYOR) skip the retry and move directly
// to the next provider.
async function callAiWithFallback(prompt, allowedSymbols) {
  for (const provider of AI_PROVIDERS) {
    const key = process.env[provider.envKey];
    if (!key) {
      console.log(`  ${provider.name}: no API key set, skipping.`);
      continue;
    }

    console.log(`  Trying ${provider.name} (${provider.model})...`);

    // --- First attempt ---
    let raw;
    try {
      raw = await provider.callFn(prompt, key, provider.model);
    } catch (err) {
      console.log(`  ${provider.name}: ${err.message}`);
      continue;  // network/rate-limit error — no retry, next provider
    }

    if (!raw) {
      console.log(`  ${provider.name}: no output returned.`);
      continue;
    }
    console.log(`  ${provider.name}: got ${raw.length} chars.`);

    const cleaned = raw.trim();
    let validation = isSafeAiText(cleaned, allowedSymbols);

    if (validation.ok) {
      console.log(`  ${provider.name}: SUCCESS (validated).`);
      return { text: cleaned, provider: provider.name };
    }

    console.log(`  ${provider.name}: validation failed — ${validation.reason}`);

    // --- Corrective retry (one shot, only if retryable) ---
    if (validation.retryable) {
      console.log(`  ${provider.name}: retrying with corrective prompt...`);
      const correctivePrompt = buildCorrectivePrompt(prompt, cleaned, validation.reason);

      let retryRaw;
      try {
        retryRaw = await provider.callFn(correctivePrompt, key, provider.model);
      } catch (err) {
        console.log(`  ${provider.name}: retry failed — ${err.message}`);
        continue;  // retry errored — next provider
      }

      if (!retryRaw) {
        console.log(`  ${provider.name}: retry returned no output.`);
        continue;
      }
      console.log(`  ${provider.name}: retry got ${retryRaw.length} chars.`);

      const retryCleaned = retryRaw.trim();
      const retryValidation = isSafeAiText(retryCleaned, allowedSymbols);

      if (retryValidation.ok) {
        console.log(`  ${provider.name}: SUCCESS on retry (validated).`);
        return { text: retryCleaned, provider: provider.name };
      }

      console.log(`  ${provider.name}: retry also failed — ${retryValidation.reason}`);
      // Fall through to next provider
    } else {
      console.log(`  ${provider.name}: failure not retryable, moving to next provider.`);
    }
  }

  console.log(`  All AI providers failed or returned invalid output. Falling back to template.`);
  return null;
}

// ---------------------------------------------------------------------------
// NEW (v2): buildAiPost now accepts a 4th argument `ctx` (context) that
// carries the supplementary data each style might need. The function picks
// what's relevant for the chosen style and builds the prompt accordingly.
// If the required data for a style isn't available, it returns null and
// main() falls back to a template.
// ---------------------------------------------------------------------------
async function buildAiPost(data, dayIndex, style, ctx = {}) {
  const { globalMarket, fng, anomalies, trending } = ctx;

  // v4.1: Each style now has its own directive + example post.
  // v4.2: Examples now use $COIN1/$COIN2/$COIN3 placeholders instead of real
  // tickers. Previously, the model was copying example cashtags (BTC, ETH, BNB)
  // alongside the actual data symbols, producing 6 cashtags when max is 3.
  // These placeholders don't match the cashtag regex ($[A-Z]{2,6}\b — note
  // the digit prevents a word boundary match), so even if the model copies
  // them, they won't be counted as cashtags by validation.
  const styleConfig = {
    snapshot: {
      directive: "List today's prices for these coins, weaving in at least one extra data point per coin beyond price and 24h change (7-day change or 24h volume — whatever the data provides). Then one short observation about the overall direction. Don't describe what the numbers show — let the numbers show it.",
      example: "$COIN1 $67,234 (+2.1% 24h, +8.4% 7d) on $28B volume · $COIN2 $3,456 (-1.2% 24h) · $COIN3 $567 (+0.5% 24h, -3.1% 7d). $COIN1 leading both the day and the week while the others drift. Not financial advice. DYOR.",
    },
    mover: {
      directive: "Lead with the coin that moved most. State the move and current price in one sentence. Add one line of neutral context using at least two of: volume, 24h high/low range, 7-day change — whatever the data provides. Don't speculate on why it moved.",
      example: "Today's biggest mover: $COIN1 at $123, up 5.4% in 24h on $4.5B volume. Traded between $118 and $126 today, and is up 11% over the past week. Not financial advice. DYOR.",
    },
    educational: {
      directive: "Explain ONE crypto concept in plain language in 2 sentences. Then mention one coin's current price as a concrete example. Don't list multiple concepts — pick one and explain it well.",
      example: "Market cap = price × circulating supply. It values coins already in circulation, not future token unlocks. For context, $COIN1 at $67,234 has a market cap around $1.3T. Not financial advice. DYOR.",
    },
    macro: {
      directive: "Give the big picture in 2 sentences: total market cap + BTC dominance + (if available) sentiment. Mention one featured coin briefly. Don't list every number — pick the 2-3 that tell the story.",
      example: "Total crypto market cap sits at $2.28T with dominance concentrated in the top asset. Fear & Greed at 24/100 (extreme fear). $COIN1 at $67,234 holding above recent lows. Not financial advice. DYOR.",
    },
    anomaly: {
      directive: "State the unusual move(s) factually — coin, direction, magnitude, in one sentence per coin. Add one line noting this is notable without interpreting it as a trade setup. Maximum 3 coins.",
      example: "Unusual 24h moves: $COIN1 +12.3% (vol $4.5B), $COIN2 -8.5% (vol $2.1B). Both moves stand out against an otherwise quiet watchlist. Not financial advice. DYOR.",
    },
    trending: {
      directive: "List what's trending on CoinGecko right now. One compact line, then one sentence of context (why these might be getting attention — but no speculation about price direction). Don't describe the rankings — the numbers already show them.",
      example: "Trending on CoinGecko: $COIN1 (rank #5), $COIN2 (rank #1), $COIN3 (rank #10). Search interest spiking across both established names and newer entrants. Not financial advice. DYOR.",
    },
    sentiment: {
      directive: "State the Fear & Greed reading and what it means. One sentence on what this extreme historically coincides with — without framing it as a buy/sell signal. Mention one coin's price as an anchor.",
      example: "Fear & Greed Index at 24/100 — extreme fear territory. Historically this reading has coincided with capitulation and high volatility, not a directional signal by itself. $COIN1 at $67,234. Not financial advice. DYOR.",
    },
  };

  const config = styleConfig[style];
  if (!config) return null;

  const allowedSymbols = [];
  const dataLines = [];

  if (style === "anomaly" && anomalies && anomalies.length > 0) {
    const top3 = anomalies.slice(0, MAX_CASHTAGS_PER_POST);
    for (const a of top3) {
      allowedSymbols.push(a.symbol);
      const dir = a.changePct >= 0 ? "up" : "down";
      dataLines.push(`${a.symbol}: ${dir} ${Math.abs(a.changePct).toFixed(1)}% in 24h, volume ${fmtMcap(a.volume)}`);
    }
  } else if (style === "trending" && trending && trending.length > 0) {
    const top3 = trending.slice(0, MAX_CASHTAGS_PER_POST);
    for (const t of top3) {
      allowedSymbols.push(t.symbol);
      dataLines.push(`${t.symbol} (${t.name}), market cap rank #${t.rank}`);
    }
  } else if (style === "macro" && globalMarket) {
    const featured = rotateSubset(data, 2, dayIndex);
    for (const d of featured) {
      allowedSymbols.push(d.symbol);
      dataLines.push(`${d.symbol}: ${fmtPrice(d.price)}, 24h change ${fmtPct(d.change24h)}`);
    }
    dataLines.push(`Total crypto market cap: ${fmtMcap(globalMarket.totalMcap)} (${fmtPct(globalMarket.mcapChange24h)} 24h)`);
    dataLines.push(`BTC dominance: ${globalMarket.btcDominance.toFixed(1)}%`);
    dataLines.push(`24h volume: ${fmtMcap(globalMarket.totalVolume)}`);
    if (fng) dataLines.push(`Fear & Greed Index: ${fng.value}/100 (${fng.classification})`);
  } else if (style === "sentiment" && fng) {
    const featured = rotateSubset(data, 2, dayIndex);
    for (const d of featured) {
      allowedSymbols.push(d.symbol);
      dataLines.push(`${d.symbol}: ${fmtPrice(d.price)}, 24h change ${fmtPct(d.change24h)}`);
    }
    dataLines.push(`Fear & Greed Index: ${fng.value}/100 (${fng.classification})`);
  } else if (style === "mover") {
    // v5: mover needs the single biggest mover, with volume + range + 7d
    // context so the AI has more than one number to work with.
    let best = null;
    for (const d of data) {
      if (!best || Math.abs(d.change24h) > Math.abs(best.change24h)) best = d;
    }
    if (best) {
      allowedSymbols.push(best.symbol);
      dataLines.push(`${best.symbol}: ${fmtPrice(best.price)}, 24h change ${fmtPct(best.change24h)}, 7d change ${fmtPct(best.change7d)}, 24h volume ${fmtMcap(best.volume24h)}, 24h range ${fmtPrice(best.low24h)}\u2013${fmtPrice(best.high24h)}`);
    }
  } else {
    // Default: snapshot-style with the core watchlist. v5: added 7d change
    // and 24h volume so each coin carries more than 2 raw numbers.
    const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
    for (const d of featured) {
      allowedSymbols.push(d.symbol);
      dataLines.push(`${d.symbol}: ${fmtPrice(d.price)}, 24h change ${fmtPct(d.change24h)}, 7d change ${fmtPct(d.change7d)}, 24h volume ${fmtMcap(d.volume24h)}`);
    }
  }

  if (allowedSymbols.length === 0 || dataLines.length === 0) return null;

  // v4.1: Rewritten prompt — shorter, more directive, with per-style examples.
  // v4.2: Added explicit instruction not to copy example symbols, and
  // examples now use $COIN1/$COIN2/$COIN3 placeholders (see styleConfig).
  const prompt = [
    "You write like a knowledgeable friend texting a quick market update — concise, direct, no filler.",
    "",
    `TASK: ${config.directive}`,
    "",
    "DATA (use only this, do not invent numbers):",
    dataLines.join("\n"),
    "",
    allowedSymbols.length === 1
      ? `CASHTAGS: Use $TICKER for ${allowedSymbols.map((s) => "$" + s).join(", ")} at least once. Use ONLY this symbol — no others.`
      : `CASHTAGS: Use $TICKER for at least 2 of: ${allowedSymbols.map((s) => "$" + s).join(", ")}. Max ${MAX_CASHTAGS_PER_POST} total. Use ONLY these symbols — no others.`,
    "",
    "STYLE RULES:",
    "- 2-3 sentences total. Short and dense beats long and repetitive.",
    "- Do NOT repeat information. If you said the rank, don't say 'ranking well'.",
    "- Do NOT use filler phrases: 'making appearances', 'continues to see', 'needs no introduction', 'it's worth noting'.",
    "- Do NOT describe what the numbers already show. Don't say 'maintaining its position' — the rank shows that.",
    "- No trading suggestions, predictions, or hype words.",
    "- End with exactly: Not financial advice. DYOR.",
    "",
    `EXAMPLE (${style} style — match this density, don't copy the words):`,
    config.example,
    "",
    "The EXAMPLE shows format only. Its $COIN1/$COIN2/$COIN3 are placeholders — do NOT use them. Use ONLY the real symbols from DATA above.",
    "Do not name any coin, by symbol or full name (e.g. Bitcoin, Ethereum), that isn't in DATA above — even if it's true in general, if it's not in today's data it doesn't belong in this post.",
    "",
    "Output ONLY the post text. No preamble, no quotes, no markdown.",
  ].join("\n");

  // v4: Use multi-provider fallback chain instead of single Gemini call.
  // callAiWithFallback tries Groq → OpenAI → Gemini, returns { text, provider }
  // or null if all fail. Validation runs inside the chain on each provider's output.
  const result = await callAiWithFallback(prompt, allowedSymbols);
  if (result) {
    return result.text;  // main() will use this as the post text
  }
  return null;  // all providers failed — main() falls back to template
}

// ===========================================================================
// TEMPLATE DISPATCHER (NEW v2)
// ---------------------------------------------------------------------------
// Given a style and context, calls the right template builder. Returns null
// if the template can't be built (e.g., required data is missing), so
// main() can fall back to the snapshot template.
// ===========================================================================

function buildTemplatePost(data, dayIndex, style, ctx = {}) {
  switch (style) {
    case "anomaly":
      return buildAnomalyRadarPost(ctx.anomalies);
    case "sentiment":
      return buildMarketSentimentPost(ctx.fng, data, dayIndex);
    case "macro":
      if (!ctx.globalMarket) return null;
      return buildMacroOverviewPost(data, dayIndex, ctx.globalMarket, ctx.fng);
    case "trending":
      if (!ctx.trending || ctx.trending.length === 0) return null;
      return buildTrendingTodayPost(ctx.trending);
    case "snapshot":
      return buildSnapshotPost(data, dayIndex);
    case "mover":
      return buildTopMoverPost(data);
    case "educational":
      return buildEducationalPost(data, dayIndex);
    default:
      return buildSnapshotPost(data, dayIndex);
  }
}

// ===========================================================================
// WEEKLY CHART IMAGE (Sundays) — unchanged from v1.
// Vendored from github.com/binance/binance-skills-hub
// (skills/binance/square-post/scripts/lib.mjs). Binance's own docs warn
// against hand-coding this upload flow, so we reuse their logic.
// ===========================================================================

async function squareApi(endpoint, apiKey, body, baseUrl = SQUARE_BASE_V2) {
  // DRY RUN GATE (v3.1): the single source of truth for dry-run mode.
  // Every Binance API call goes through this function, so checking here
  // covers ALL code paths: text posts, article posts, image uploads,
  // image status polls, content publishing. No path can bypass dry-run.
  if (isDryRun() && endpoint !== "/image/imageStatus") {
    // Allow image status polling in dry run so the upload flow can be tested
    // end-to-end without posting. But block presignedUrl (would upload to S3)
    // and content/add (would publish).
    if (endpoint === "/image/presignedUrl") {
      console.log(`[DRY RUN] Would request presigned S3 URL for image upload. Skipping.`);
      return { presignedUrl: "https://dry-run.example.com/dummy-url", fileTicket: "dry-run-ticket" };
    }
    if (endpoint === "/content/add") {
      console.log(`[DRY RUN] Would publish to Binance Square. Skipping.`);
      console.log(`[DRY RUN] Payload:`, JSON.stringify(body, null, 2));
      return { id: "dry-run-id", shareLink: "https://www.binance.com/square/post/dry-run" };
    }
    console.log(`[DRY RUN] Would call Square API ${endpoint}. Skipping.`);
    return {};
  }

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: {
      "X-Square-OpenAPI-Key": apiKey,
      "Content-Type": "application/json",
      clienttype: "binanceSkill",
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();

  if (endpoint === "/content/add" && res.status === 504) {
    return { id: null, shareLink: null, publishStatus: "success_without_post_id" };
  }

  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`Square API returned non-JSON response: ${res.status}`);
  }
  if (json.code !== "000000") {
    throw new Error(`Square API error [${json.code}]: ${json.message}`);
  }
  return json.data;
}

// Helper: dry-run flag check, centralized so it can't drift.
function isDryRun() {
  return process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
}

async function uploadImageToSquare(apiKey, filePath) {
  const imageName = path.basename(filePath);
  const { presignedUrl, fileTicket } = await squareApi("/image/presignedUrl", apiKey, { imageName });

  // DRY RUN: skip the actual S3 PUT — the presignedUrl is a dummy.
  if (isDryRun()) {
    console.log(`[DRY RUN] Would PUT ${imageName} to S3. Skipping actual upload.`);
    // Skip polling too — return a dummy URL.
    return "https://dry-run.example.com/uploaded-image.png";
  }

  const fileBuffer = fs.readFileSync(filePath);
  const putRes = await fetch(presignedUrl, {
    method: "PUT",
    headers: { "Content-Type": "image/png" },
    body: fileBuffer,
  });
  if (!putRes.ok) throw new Error(`S3 upload failed: ${putRes.status}`);

  for (let i = 0; i < IMAGE_MAX_POLL_RETRIES; i++) {
    const status = await squareApi("/image/imageStatus", apiKey, { fileTicket });
    if (status.status === 1) return status.imageUrl;
    if (status.status === 2) throw new Error(`Image processing failed: ${status.failedReason}`);
    await new Promise((r) => setTimeout(r, IMAGE_POLL_INTERVAL_MS));
  }
  throw new Error("Image processing poll timed out");
}

async function publishToSquare(apiKey, body) {
  return squareApi("/content/add", apiKey, body, SQUARE_BASE_V1);
}

function buildWeeklyChartConfig(featured) {
  const COLORS = ["#F0B90B", "#627EEA", "#00FFA3"];
  const datasets = featured
    .filter((d) => Array.isArray(d.sparkline7d) && d.sparkline7d.length > 1)
    .map((d, i) => {
      const base = d.sparkline7d[0];
      const points = d.sparkline7d.map((p) => (base ? ((p - base) / base) * 100 : 0));
      return {
        label: `$${d.symbol}`,
        data: points,
        borderColor: COLORS[i % COLORS.length],
        backgroundColor: "transparent",
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.15,
      };
    });

  if (datasets.length === 0) return null;

  const pointCount = datasets[0].data.length;
  const labels = Array.from({ length: pointCount }, (_, i) => {
    const daysAgo = 7 - (i / pointCount) * 7;
    return daysAgo <= 0.15 ? "now" : `-${daysAgo.toFixed(1)}d`;
  });

  return {
    type: "line",
    data: { labels, datasets },
    options: {
      title: { display: true, text: "7-Day Change (%)" },
      legend: { display: true, position: "bottom" },
      scales: {
        xAxes: [{ ticks: { maxTicksLimit: 6 } }],
        yAxes: [{ ticks: { callback: (v) => `${v}%` } }],
      },
    },
  };
}

async function renderChartPng(chartConfig) {
  const res = await fetch(QUICKCHART_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chart: chartConfig,
      width: 800,
      height: 450,
      backgroundColor: "#0B0E11",
      format: "png",
    }),
  });
  if (!res.ok) throw new Error(`QuickChart error: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function tryWeeklyImagePost(data, dayIndex, apiKey) {
  try {
    const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
    const chartConfig = buildWeeklyChartConfig(featured);
    if (!chartConfig) {
      console.log("No sparkline data available, skipping image post.");
      return null;
    }

    const png = await renderChartPng(chartConfig);

    const tmpFile = path.join(os.tmpdir(), `weekly-chart-${Date.now()}.png`);
    fs.writeFileSync(tmpFile, png);

    const imageUrl = await uploadImageToSquare(apiKey, tmpFile);
    fs.unlinkSync(tmpFile);

    const caption = buildWeeklyImageCaption(featured);
    const result = await publishToSquare(apiKey, {
      contentType: 1,
      bodyTextOnly: caption,
      imageList: [imageUrl],
    });
    return result;
  } catch (err) {
    console.log(`Weekly image post failed (${err.message}), falling back to text.`);
    return null;
  }
}

// ===========================================================================
// POSTING
// ---------------------------------------------------------------------------
// v3 fix: Text posts now explicitly send `contentType: 1`. Without it,
// Binance was defaulting to article mode and only showing the first line.
// ===========================================================================

// NEW (v3): Length guard. If a post exceeds MAX_POST_LENGTH, trim trailing
// lines until it fits. Always preserves the opening line (the hook) and the
// closing DYOR line if present. Logs when trimming happens so you can see it.
function enforceMaxLength(text) {
  if (text.length <= MAX_POST_LENGTH) return text;
  console.log(`Post is ${text.length} chars (limit ${MAX_POST_LENGTH}), trimming trailing lines.`);
  const lines = text.split("\n");
  // Keep first line (hook), drop middle lines from the end, keep last 2 lines (DYOR disclaimer)
  const kept = [lines[0]];
  let total = lines[0].length + 1;
  // Add the closing lines (typically the last 2: empty + DYOR)
  const closing = lines.slice(-2);
  const closingLen = closing.join("\n").length + 1;
  // Add middle lines until we hit the budget
  for (const line of lines.slice(1, -2)) {
    if (total + line.length + 1 + closingLen > MAX_POST_LENGTH - 20) break;  // leave 20 char margin
    kept.push(line);
    total += line.length + 1;
  }
  kept.push("", "...");
  kept.push(...closing);
  const result = kept.join("\n");
  console.log(`Trimmed to ${result.length} chars.`);
  return result;
}

async function postToSquare(text) {
  const key = process.env.BINANCE_SQUARE_OPENAPI_KEY;
  if (!key) {
    throw new Error("Missing BINANCE_SQUARE_OPENAPI_KEY environment variable.");
  }
  const safeText = enforceMaxLength(text);

  // v3.1: dry-run is now handled centrally in squareApi(). This function
  // still logs the payload for visibility, but the actual gate is below.
  if (isDryRun()) {
    console.log(`=== DRY RUN (TEXT POST) — not posting to Binance ===`);
    console.log(`Payload contentType: ${CONTENT_TYPE_TEXT}`);
    console.log(`Payload bodyTextOnly (${safeText.length} chars):`);
    console.log(safeText);
    console.log(`=== END DRY RUN ===`);
  }

  // v3 FIX: explicitly set contentType: 1 for text posts.
  // Without this, Binance was treating posts as articles and only showing
  // the first line (~6 words). With it, the full text displays correctly.
  const data = await publishToSquare(key, {
    contentType: CONTENT_TYPE_TEXT,
    bodyTextOnly: safeText,
  });
  return data?.id;
}

// NEW (v3): Article post — long-form weekly recap with title + markdown body.
// Used on Sundays instead of (or alongside) the chart-only post.
// Falls back gracefully: if article API call fails, caller falls back to
// chart-only post, then text weekly recap.
async function postArticleToSquare(title, body, coverImageUrl = null) {
  const key = process.env.BINANCE_SQUARE_OPENAPI_KEY;
  if (!key) {
    throw new Error("Missing BINANCE_SQUARE_OPENAPI_KEY environment variable.");
  }
  const payload = {
    contentType: CONTENT_TYPE_ARTICLE,
    title,
    content: body,  // Binance's article endpoint accepts markdown in `content`
  };
  if (coverImageUrl) {
    payload.coverImageList = [coverImageUrl];
  }

  // v3.1: dry-run is now handled centrally in squareApi(). This function
  // still logs the article payload for visibility.
  if (isDryRun()) {
    console.log(`=== DRY RUN (ARTICLE) — not posting to Binance ===`);
    console.log(`Title: ${title}`);
    console.log(`Body length: ${body.length} chars`);
    console.log(`Cover image: ${coverImageUrl ? "yes" : "no"}`);
    console.log(`--- Body ---`);
    console.log(body);
    console.log(`=== END DRY RUN ===`);
  }

  const data = await publishToSquare(key, payload);
  return data?.id;
}

// ===========================================================================
// WEEKLY ARTICLE BUILDER (NEW v3)
// ---------------------------------------------------------------------------
// Builds a long-form weekly recap article with markdown body. Pulls together
// everything the script knows: watchlist prices + 7d changes, global market,
// sentiment, anomalies, trending, and an educational concept. Returns
// { title, body } or null if core data is missing.
// ===========================================================================

function buildWeeklyArticle(data, dayIndex, ctx = {}) {
  const { globalMarket, fng, anomalies, trending } = ctx;
  if (!data || data.length === 0) return null;

  const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
  const weekRange = getWeekRange();
  const title = `Weekly Crypto Recap — ${weekRange}`;

  const sections = [];

  // Section 1: Market overview (if global data available)
  if (globalMarket) {
    sections.push(`## Market Overview`);
    sections.push(`Total crypto market cap: **${fmtMcap(globalMarket.totalMcap)}** (${fmtPct(globalMarket.mcapChange24h)} in the last 24h).`);
    sections.push(`BTC dominance: **${globalMarket.btcDominance.toFixed(1)}%**. 24h volume: ${fmtMcap(globalMarket.totalVolume)}.`);
    if (fng) {
      sections.push(`Fear & Greed Index: **${fng.value}/100** (${fng.classification}).`);
    }
    sections.push("");
  }

  // Section 2: Watchlist performance this week
  sections.push(`## Watchlist Performance (7-day)`);
  for (const coin of featured) {
    sections.push(`- **$${coin.symbol}**: ${fmtPrice(coin.price)} (${fmtPct(coin.change7d)} this week)`);
  }
  sections.push("");

  // Section 3: Notable moves (from anomaly scan, if any)
  if (anomalies && anomalies.length > 0) {
    sections.push(`## Notable Moves This Week`);
    for (const a of anomalies.slice(0, 5)) {
      const dir = a.changePct >= 0 ? "up" : "down";
      sections.push(`- **$${a.symbol}**: ${dir} ${Math.abs(a.changePct).toFixed(1)}% in 24h (volume ${fmtMcap(a.volume)})`);
    }
    sections.push("");
  }

  // Section 4: Trending coins (if available)
  if (trending && trending.length > 0) {
    sections.push(`## Trending Searches`);
    sections.push(`Most-searched coins on CoinGecko this week:`);
    for (const t of trending.slice(0, 3)) {
      sections.push(`- **$${t.symbol}** (${t.name}) — market cap rank #${t.rank}`);
    }
    sections.push("");
  }

  // Section 5: Educational concept (rotating)
  sections.push(`## This Week's Concept`);
  sections.push(EDU_TIPS[dayIndex % EDU_TIPS.length]);
  sections.push("");

  // Closing
  sections.push(`---`);
  sections.push(`*Weekly recap, not financial advice. Always DYOR.*`);

  const body = sections.join("\n");
  return { title, body };
}

// Returns a human-readable week range string like "July 7–13, 2026"
function getWeekRange() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sunday
  const sunday = new Date(now);
  sunday.setDate(now.getDate() - day); // most recent Sunday
  const saturday = new Date(sunday);
  saturday.setDate(sunday.getDate() + 6); // following Saturday

  const months = ["January", "February", "March", "April", "May", "June",
                  "July", "August", "September", "October", "November", "December"];
  const startMonth = months[sunday.getMonth()];
  const endMonth = months[saturday.getMonth()];
  const startDay = sunday.getDate();
  const endDay = saturday.getDate();
  const year = saturday.getFullYear();

  if (startMonth === endMonth) {
    return `${startMonth} ${startDay}–${endDay}, ${year}`;
  }
  return `${startMonth} ${startDay} – ${endMonth} ${endDay}, ${year}`;
}

// ===========================================================================
// SUNDAY WEEKLY ARTICLE (NEW v3)
// ---------------------------------------------------------------------------
// Tries to post a full weekly article with the 7-day chart as cover image.
// Fallback ladder:
//   1. Article + chart cover image (best case)
//   2. Article without cover image (if chart render fails)
//   3. Chart-only image post (if article API fails)
//   4. Plain-text weekly recap (if everything fails)
// ===========================================================================

async function tryWeeklyArticlePost(data, dayIndex, key, ctx) {
  const article = buildWeeklyArticle(data, dayIndex, ctx);
  if (!article) {
    console.log("Could not build weekly article (missing data), falling back to chart post.");
    return null;
  }

  // Try to render the chart for use as cover image
  let coverImageUrl = null;
  try {
    const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
    const chartConfig = buildWeeklyChartConfig(featured);
    if (chartConfig) {
      const png = await renderChartPng(chartConfig);
      const tmpFile = path.join(os.tmpdir(), `weekly-chart-${Date.now()}.png`);
      fs.writeFileSync(tmpFile, png);
      coverImageUrl = await uploadImageToSquare(key, tmpFile);
      fs.unlinkSync(tmpFile);
      console.log(`Chart rendered for article cover image.`);
    }
  } catch (err) {
    console.log(`Chart render for article failed (${err.message}), posting article without cover.`);
    coverImageUrl = null;
  }

  // Try to publish as article
  try {
    const id = await postArticleToSquare(article.title, article.body, coverImageUrl);
    console.log(`--- Posted weekly ARTICLE (source: article) ---`);
    console.log(`Title: ${article.title}`);
    console.log(`Body length: ${article.body.length} chars`);
    console.log(`Cover image: ${coverImageUrl ? "yes" : "no"}`);
    if (isDryRun()) {
      console.log(`[DRY RUN] No article was actually published. Verify the payload above looks correct, then re-run with dry_run unchecked.`);
    } else if (id && id !== "dry-run-id") {
      console.log(`Posted! View it at: https://www.binance.com/square/post/${id}`);
    }
    return { id, isArticle: true };
  } catch (err) {
    console.log(`Article post failed (${err.message}), falling back to chart-only post.`);
    return null;
  }
}

// ===========================================================================
// MAIN — smart template selection with Sunday article (v3)
// ===========================================================================

async function main() {
  const key = process.env.BINANCE_SQUARE_OPENAPI_KEY;
  if (!key) {
    throw new Error("Missing BINANCE_SQUARE_OPENAPI_KEY environment variable.");
  }

  const now = new Date();
  const dayIndex = now.getDate();
  const isSunday = now.getDay() === 0;

  // v4: AI is enabled if ANY provider key is set (Groq, OpenRouter, or Gemini)
  // v4.2 BUG FIX: was checking OPENAI_API_KEY (leftover from before the
  // OpenRouter swap). If only OPENROUTER_API_KEY was set, aiEnabled evaluated
  // false and AI was silently skipped — no error, just straight to template.
  const aiEnabled = Boolean(
    process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY
  );

  // v4: Log available providers at startup so you can see which are configured
  const configuredProviders = AI_PROVIDERS
    .filter(p => process.env[p.envKey])
    .map(p => p.name);
  if (configuredProviders.length > 0) {
    console.log(`AI providers configured: ${configuredProviders.join(", ")}`);
  } else {
    console.log(`No AI providers configured — using template mode only.`);
  }

  // --- Sunday: weekly ARTICLE (v3) with chart as cover image ---
  // Fallback ladder: article+chart → article-only → chart-only → text recap
  if (isSunday) {
    const data = await getMarketData({ sparkline: true });

    // Gather supplementary data for the article body
    let anomalies = null, trending = null, globalMarket = null, fng = null;
    try { anomalies = await getBinanceAnomalies(); } catch (e) { console.log(`Anomaly scan skipped: ${e.message}`); }
    try { trending = await getTrendingCoins(); } catch (e) { console.log(`Trending fetch skipped: ${e.message}`); }
    try { globalMarket = await getGlobalMarket(); } catch (e) { console.log(`Global market fetch skipped: ${e.message}`); }
    try { fng = await getFearGreed(); } catch (e) { console.log(`Fear & Greed fetch skipped: ${e.message}`); }

    const ctx = { globalMarket, fng, anomalies, trending };

    // Try article first
    const articleResult = await tryWeeklyArticlePost(data, dayIndex, key, ctx);
    if (articleResult) return;

    // Fallback 1: chart-only image post
    const imageResult = await tryWeeklyImagePost(data, dayIndex, key);
    if (imageResult) {
      console.log(`--- Posted weekly chart image (source: image, article fallback) ---`);
      if (isDryRun()) {
        console.log(`[DRY RUN] No image post was actually published.`);
      } else {
        console.log(`ID: ${imageResult.id ?? "unavailable"}`);
        console.log(`Link: ${imageResult.shareLink ?? (imageResult.id ? `https://www.binance.com/square/post/${imageResult.id}` : "unavailable")}`);
      }
      return;
    }

    // Fallback 2: plain-text weekly recap
    const text = buildWeeklyRecapPost(data, dayIndex);
    console.log(`--- Post preview (source: template, all fallbacks) ---`);
    console.log(text);
    console.log("--------------------");
    const id = await postToSquare(text);
    if (isDryRun()) {
      console.log(`[DRY RUN] No post was actually published.`);
    } else if (id && id !== "dry-run-id") {
      console.log(`Posted! View it at: https://www.binance.com/square/post/${id}`);
    } else {
      console.log("Post likely succeeded, but no ID was returned in the response.");
    }
    return;
  }

  // ===========================================================================
  // STAGE 1: RESEARCH — gather data from all free sources
  // ===========================================================================
  console.log(`\n=== STAGE 1: RESEARCH (data gathering) ===`);

  // Always fetch core market data first — most templates need it.
  const data = await getMarketData();
  console.log(`  CoinGecko markets: ${data.length} coins fetched.`);

  // Gather supplementary data. Each fetch is independent and fails gracefully
  // — if one source is down, the others still work and the script picks the
  // best template from what's available.
  let anomalies = null;
  let trending = null;
  let globalMarket = null;
  let fng = null;

  try {
    anomalies = await getBinanceAnomalies();
    if (anomalies.length > 0) {
      console.log(`  Binance ticker: found ${anomalies.length} anomaly/anomalies (|24h| >= ${ANOMALY_THRESHOLD_PCT}%).`);
    } else {
      console.log(`  Binance ticker: nothing unusual (threshold ${ANOMALY_THRESHOLD_PCT}%).`);
    }
  } catch (e) {
    console.log(`  Binance ticker: skipped (${e.message}).`);
  }

  try {
    trending = await getTrendingCoins();
    console.log(`  CoinGecko trending: ${trending.length} top-100 coin(s).`);
  } catch (e) {
    console.log(`  CoinGecko trending: skipped (${e.message}).`);
  }

  try {
    globalMarket = await getGlobalMarket();
    console.log(`  CoinGecko global: cap ${fmtMcap(globalMarket.totalMcap)}, BTC dom ${globalMarket.btcDominance.toFixed(1)}%.`);
  } catch (e) {
    console.log(`  CoinGecko global: skipped (${e.message}).`);
  }

  try {
    fng = await getFearGreed();
    console.log(`  Fear & Greed: ${fng.value}/100 (${fng.classification}).`);
  } catch (e) {
    console.log(`  Fear & Greed: skipped (${e.message}).`);
  }

  // ===========================================================================
  // STAGE 2: STRATEGIST — pick the content angle based on what data shows
  // ===========================================================================
  console.log(`\n=== STAGE 2: STRATEGIST (template selection) ===`);

  let style = null;
  const ctx = { globalMarket, fng, anomalies, trending };

  if (anomalies && anomalies.length > 0) {
    style = "anomaly";
    console.log(`  Decision: anomaly detected → "anomaly" template.`);
  } else if (fng && (fng.value <= EXTREME_FEAR_THRESHOLD || fng.value >= EXTREME_GREED_THRESHOLD)) {
    style = "sentiment";
    console.log(`  Decision: extreme sentiment (${fng.value}/100) → "sentiment" template.`);
  } else {
    const rotation = ["macro", "trending", "snapshot", "mover", "educational"];
    style = rotation[dayIndex % rotation.length];
    console.log(`  Decision: no anomaly/extreme sentiment, day ${dayIndex} → rotation "${style}".`);
  }

  // ===========================================================================
  // STAGE 3: WRITER — generate post text (AI with multi-provider fallback,
  // then template fallback)
  // ===========================================================================
  console.log(`\n=== STAGE 3: WRITER (text generation) ===`);

  let text = null;
  let source = "template";

  if (aiEnabled) {
    console.log(`  Attempting AI generation...`);
    text = await buildAiPost(data, dayIndex, style, ctx);
    if (text) {
      source = "ai";
      console.log(`  AI generation succeeded.`);
    } else {
      console.log(`  AI generation failed — falling back to template.`);
    }
  } else {
    console.log(`  AI mode disabled (no provider keys) — using template directly.`);
  }

  if (!text) {
    text = buildTemplatePost(data, dayIndex, style, ctx);
    source = aiEnabled ? "template (ai fallback)" : "template";
    console.log(`  Template built (${text.length} chars).`);
  }

  // If the chosen template couldn't be built (missing data), fall back
  // to snapshot, which only needs the core market data we already have.
  if (!text) {
    console.log(`  Template "${style}" produced no text (missing data) — snapshot fallback.`);
    text = buildSnapshotPost(data, dayIndex);
    source = "template (snapshot fallback)";
  }

  if (!text) throw new Error("Could not build post text \u2014 check CoinGecko response.");

  console.log(`\n--- Post preview (source: ${source}) ---`);
  console.log(text);
  console.log(`--------------------`);

  // ===========================================================================
  // STAGE 4: PUBLISHER — send to Binance Square
  // ===========================================================================
  console.log(`\n=== STAGE 4: PUBLISHER (Binance Square) ===`);
  console.log(`  Posting ${text.length} chars as contentType: 1 (text)...`);

  const id = await postToSquare(text);
  if (isDryRun()) {
    console.log(`  [DRY RUN] No post was actually published.`);
    console.log(`  Re-run with dry_run unchecked to publish for real.`);
  } else if (id && id !== "dry-run-id") {
    console.log(`  SUCCESS — posted! View at: https://www.binance.com/square/post/${id}`);
  } else {
    console.log(`  Post likely succeeded, but no ID was returned in the response.`);
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
