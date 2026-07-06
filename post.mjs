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
  const lines = featured.map(
    (d) => `$${d.symbol}: ${fmtPrice(d.price)} (${fmtPct(d.change24h)} 24h)`
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
  return [
    `\uD83D\uDC40 Today's biggest mover: $${best.symbol}`,
    `Price: ${fmtPrice(best.price)} \u2014 ${direction} ${Math.abs(best.change24h).toFixed(2)}% in 24h.`,
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

// Reject anything that isn't grounded in the actual data, has too many
// cashtags, or contains a banned phrase. Runs on every AI response before
// it's allowed anywhere near the post endpoint.
//
// v3.2 FIX: The previous check accepted any text >= 10 chars, which let
// through fragments like "Here's a look at some trending crypto assets"
// (44 chars, no cashtags, no DYOR line). The AI was producing incomplete
// fragments and they were being posted. Now we require:
//   - At least 120 chars (a real 2-sentence post is ~150-300 chars)
//   - At least 1 cashtag (the prompt always asks for them)
//   - The DYOR closing line (the prompt always asks for it)
//   - No more than 600 chars (was 700 — tighter to match Binance display)
function isSafeAiText(text, allowedSymbols) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();

  // Length checks — reject fragments
  if (trimmed.length < 120) {
    console.log(`AI output too short (${trimmed.length} chars, need >= 120), rejecting.`);
    return false;
  }
  if (trimmed.length > 600) {
    console.log(`AI output too long (${trimmed.length} chars, max 600), rejecting.`);
    return false;
  }

  // Must contain at least one cashtag (the prompt always asks for them)
  const tags = countCashtags(trimmed);
  if (tags.length === 0) {
    console.log("AI output has no cashtags, rejecting.");
    return false;
  }
  if (tags.length > MAX_CASHTAGS_PER_POST) {
    console.log(`AI output has ${tags.length} cashtags (max ${MAX_CASHTAGS_PER_POST}), rejecting.`);
    return false;
  }
  for (const tag of tags) {
    if (!allowedSymbols.includes(tag.slice(1))) {
      console.log(`AI output uses ungrounded cashtag ${tag}, rejecting.`);
      return false;
    }
  }

  // Must contain the DYOR closing line (the prompt always asks for it)
  const lower = trimmed.toLowerCase();
  if (!lower.includes("dyor") && !lower.includes("not financial advice")) {
    console.log("AI output missing DYOR/not-financial-advice line, rejecting.");
    return false;
  }

  // Banned phrases
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      console.log(`AI output contains banned phrase "${phrase}", rejecting.`);
      return false;
    }
  }

  return true;
}

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  // v3.3 FIX: gemini-2.5-* models are "thinking" models that burn tokens
  // on internal reasoning. If using a 2.5 model, disable thinking via
  // thinkingConfig (thinkingBudget: 0) so all tokens go to output.
  // For 2.0 and earlier models, thinkingConfig is ignored (they don't think).
  const isThinkingModel = GEMINI_MODEL.includes("2.5");
  const generationConfig = {
    maxOutputTokens: 800,  // v3.3: bumped from 500 to 800 for safety margin
    temperature: 0.4,
    topP: 0.9,
  };
  if (isThinkingModel) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig,
    }),
  });

  if (!res.ok) {
    console.log(`Gemini API non-OK response: ${res.status}`);
    // Log response body for non-OK to help diagnose model availability issues
    try {
      const errBody = await res.text();
      console.log(`Gemini error body: ${errBody.substring(0, 300)}`);
    } catch {}
    return null;
  }

  const data = await res.json();
  const candidate = data?.candidates?.[0];

  // Check finishReason. If Gemini stopped due to SAFETY, RECITATION,
  // MAX_TOKENS, or OTHER, the output is likely truncated or incomplete.
  // Log it and return null so the caller falls back to template mode.
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    console.log(`Gemini finishReason: ${finishReason} (output likely incomplete, rejecting).`);
    return null;
  }

  const text = candidate?.content?.parts?.[0]?.text;
  return text || null;
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

  const styleInstruction = {
    snapshot: "Write a short, neutral market-snapshot update covering these coins.",
    mover: "Write a short update focused on whichever of these coins moved the most in the last 24h.",
    educational: "Write a short update that gives one genuine, factual crypto/market-structure concept (e.g. market cap vs FDV, funding rates, volume), then mentions the current price of one of these coins as an aside.",
    macro: "Write a short macro market overview using the provided total market cap, BTC dominance, and (if available) sentiment. Mention 1-2 of the featured coins briefly.",
    anomaly: "Write a short post noting 1-3 of the provided unusual 24h moves. State each move factually (direction and magnitude) without interpreting it as a trade setup.",
    trending: "Write a short post about the provided trending coins. State their names and market cap ranks factually without hyping them.",
    sentiment: "Write a short post noting the current Fear & Greed reading is at an extreme. Mention what 'extreme fear' or 'extreme greed' tends to coincide with historically, without framing it as a buy or sell signal. Mention one featured coin's current price as an aside.",
  }[style];

  if (!styleInstruction) return null;

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
  } else {
    // Default: snapshot-style with the core watchlist
    const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
    for (const d of featured) {
      allowedSymbols.push(d.symbol);
      dataLines.push(`${d.symbol}: ${fmtPrice(d.price)}, 24h change ${fmtPct(d.change24h)}`);
    }
  }

  if (allowedSymbols.length === 0 || dataLines.length === 0) return null;

  const prompt = [
    "You are writing a short social media post for a factual crypto market account.",
    `Style: ${styleInstruction}`,
    "",
    `Real, current data (use ONLY this data, do not invent numbers):`,
    dataLines.join("\n"),
    "",
    `You MUST include $TICKER cashtags for at least 2 of these symbols (no more than ${MAX_CASHTAGS_PER_POST} total): ${allowedSymbols.map((s) => "$" + s).join(", ")}.`,
    "",
    "Rules:",
    "- Write 3-4 complete sentences. Do NOT stop mid-sentence.",
    "- No trading suggestions (no 'buy', 'sell', 'entry point', 'buying opportunity').",
    "- No price predictions or targets.",
    "- No hype words ('moon', 'guaranteed', '100x', 'breakout').",
    "- Plain, factual, slightly conversational tone.",
    "- End with exactly: Not financial advice. DYOR.",
    "",
    "Example of a good post (do NOT copy this, just match the format):",
    "Trending on CoinGecko today: $SOL (Solana, rank #5), $BTC (Bitcoin, rank #1), and $HYPE (Hyperliquid, rank #10). Solana continues to see strong search interest alongside its recent price action. Bitcoin needs no introduction at the top of the rankings. Not financial advice. DYOR.",
    "",
    "Output ONLY the post text. No preamble, no quotes, no markdown, no explanation.",
  ].join("\n");

  try {
    const raw = await callGemini(prompt);
    if (!raw) return null;
    const cleaned = raw.trim();
    if (!isSafeAiText(cleaned, allowedSymbols)) {
      console.log("AI output failed validation, falling back to template.");
      return null;
    }
    return cleaned;
  } catch (err) {
    console.log(`Gemini call failed (${err.message}), falling back to template.`);
    return null;
  }
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
  const aiEnabled = Boolean(process.env.GEMINI_API_KEY);

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

  // --- Weekday: smart template selection ---
  // Always fetch core market data first — most templates need it.
  const data = await getMarketData();

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
      console.log(`Anomaly scan: found ${anomalies.length} coin(s) with |24h change| >= ${ANOMALY_THRESHOLD_PCT}%.`);
    } else {
      console.log(`Anomaly scan: nothing unusual (threshold ${ANOMALY_THRESHOLD_PCT}%).`);
    }
  } catch (e) {
    console.log(`Anomaly scan skipped: ${e.message}`);
  }

  try {
    trending = await getTrendingCoins();
    console.log(`Trending: found ${trending.length} top-100 coin(s).`);
  } catch (e) {
    console.log(`Trending fetch skipped: ${e.message}`);
  }

  try {
    globalMarket = await getGlobalMarket();
    console.log(`Global market: cap ${fmtMcap(globalMarket.totalMcap)}, BTC dom ${globalMarket.btcDominance.toFixed(1)}%.`);
  } catch (e) {
    console.log(`Global market fetch skipped: ${e.message}`);
  }

  try {
    fng = await getFearGreed();
    console.log(`Fear & Greed: ${fng.value}/100 (${fng.classification}).`);
  } catch (e) {
    console.log(`Fear & Greed fetch skipped: ${e.message}`);
  }

  // --- Smart template selection ---
  // Priority 1: Anomaly — if something is genuinely moving >10%, lead with that.
  // Priority 2: Extreme sentiment — if F&G is at extreme, that's newsworthy.
  // Priority 3: Rotate through macro / trending / snapshot / mover / educational.
  let style = null;
  const ctx = { globalMarket, fng, anomalies, trending };

  if (anomalies && anomalies.length > 0) {
    style = "anomaly";
  } else if (fng && (fng.value <= EXTREME_FEAR_THRESHOLD || fng.value >= EXTREME_GREED_THRESHOLD)) {
    style = "sentiment";
  } else {
    const rotation = ["macro", "trending", "snapshot", "mover", "educational"];
    style = rotation[dayIndex % rotation.length];
  }

  console.log(`Selected template: ${style}`);

  // --- Try AI mode first (if enabled) ---
  let text = null;
  let source = "template";

  if (aiEnabled) {
    text = await buildAiPost(data, dayIndex, style, ctx);
    if (text) source = "ai";
  }

  // --- Fall back to template if AI failed or wasn't enabled ---
  if (!text) {
    text = buildTemplatePost(data, dayIndex, style, ctx);
    source = aiEnabled ? "template (ai fallback)" : "template";
  }

  // --- If the chosen template couldn't be built (missing data), fall back
  //     to snapshot, which only needs the core market data we already have.
  if (!text) {
    console.log(`Template "${style}" produced no text (missing data), falling back to snapshot.`);
    text = buildSnapshotPost(data, dayIndex);
    source = "template (snapshot fallback)";
  }

  if (!text) throw new Error("Could not build post text \u2014 check CoinGecko response.");

  console.log(`--- Post preview (source: ${source}) ---`);
  console.log(text);
  console.log("--------------------");

  const id = await postToSquare(text);
  if (isDryRun()) {
    console.log(`[DRY RUN] No post was actually published. Verify the payload above looks correct, then re-run with dry_run unchecked.`);
  } else if (id && id !== "dry-run-id") {
    console.log(`Posted! View it at: https://www.binance.com/square/post/${id}`);
  } else {
    console.log("Post likely succeeded, but no ID was returned in the response.");
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
