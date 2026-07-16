// post.mjs  (v9 — upgraded)
// ============================================================================
// Fetches live crypto data from MULTIPLE free, no-key sources and posts to
// Binance Square with $cashtags.
//
// What's new in v9 (vs v8):
//   - NEW: Two more rotation styles — "digest" (top-100 breadth: best
//     gainer, worst loser, how many of the top 100 are green) and
//     "spotlight" (deep-dive on one coin OUTSIDE the 8-coin core watchlist).
//     Both are powered by a new getBroadMarketMovers() fetcher (CoinGecko
//     /coins/markets, top 100 by market cap). Rotation array grew from 7 to
//     9 entries — still coprime with the 5-vibe rotation, so the full
//     vibe×template cycle is now 45 days instead of shrinking back toward
//     lockstep.
//   - NEW: Optional cross-post of the same text to X/Twitter, from this
//     SAME account — one voice, syndicated to a second platform. Fully
//     optional (skips gracefully if the 4 TWITTER_* secrets aren't all
//     set) and never blocks or fails the Binance Square post if the X call
//     errors. Posting to X requires user-context auth (OAuth 1.0a or OAuth
//     2.0 PKCE) as of 2026 — an app-only bearer token cannot post — so this
//     implements OAuth 1.0a signing directly (no new dependency).
//   - BUG FIX: fmtPrice() rounded any price under $0.0001 down to a
//     misleading "$0.00" (4-decimal cap was fine for the original 8-coin
//     watchlist, whose cheapest coin never got that low, but the new
//     top-100-wide digest/spotlight styles regularly surface sub-cent meme
//     coins). Precision now scales with magnitude instead of one fixed cap.
//   - Scope note: this pass deliberately does NOT include multi-account
//     deployment, automated "Chat Room" community bots, or CreatorPad
//     reward-farming automation. Those were in the brainstorm doc but they
//     center on making a handful of accounts controlled by one operator
//     look like independent, organically-engaged voices/community — that's
//     the part that's out of scope here, not the underlying tech.
//
// What was new in v8 (preserved):
//   - BIGGEST CHANGE: the Sunday weekly article no longer builds itself and
//     publishes itself unattended. It's now RUN_MODE=weekly-draft (writes a
//     draft, zero Binance calls) + RUN_MODE=weekly-publish (posts only after
//     a human adds the `approved-for-posting` label to the GitHub Issue the
//     draft becomes). See weekly-article-draft.yml / weekly-article-publish
//     .yml and the big comment above runWeeklyDraftMode() in this file.
//   - The old Sunday auto-publish ladder (article+chart → article-only →
//     chart-only → text recap, all inside main()) is gone. Weekdays are
//     completely unaffected; main() on a Sunday now just logs and returns,
//     leaving the article to the two new workflows.
//
// What was new in v3 (preserved, weekday behavior unaffected by v8):
//   - BUG FIX: Text posts now explicitly send `contentType: 1`. Without it,
//     Binance was treating posts as articles and only showing the first line
//     (~6 words). All weekday text posts now publish correctly in full.
//   - NEW: Weekly ARTICLE builder — long-form weekly recap with title,
//     markdown body, and a 7-day chart. (As of v8, WHEN this publishes is no
//     longer automatic on Sundays — see above.)
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
//   - Same $0 / no-PC / mobile-only architecture (GitHub Actions + this file
//     plus two small new workflow files — see below — still no server, no PC).
//   - daily-post.yml itself is unchanged; it just now no-ops on Sundays.
//   - Same GitHub secrets (BINANCE_SQUARE_OPENAPI_KEY, optional GEMINI_API_KEY).
//   - Same Binance Square API endpoints and official upload flow.
//   - Same MAX_CASHTAGS_PER_POST = 3 limit (Binance error 220095).
//   - Same banned-phrases list and AI safety validation.
//   - Same fallback philosophy for the DAILY post: if anything fails, post
//     *something* rather than skip a day. This does NOT apply to the weekly
//     article anymore — RUN_MODE=weekly-publish fails loudly instead of
//     substituting different content for what a human approved.
//
// Requires: Node.js 18+ (built-in fetch, crypto). No npm install needed.
// Required env var: BINANCE_SQUARE_OPENAPI_KEY (not needed for RUN_MODE=weekly-draft)
// Optional env var: GEMINI_API_KEY (free at aistudio.google.com/apikey)
// Optional (v9): TWITTER_API_KEY, TWITTER_API_SECRET, TWITTER_ACCESS_TOKEN,
//   TWITTER_ACCESS_TOKEN_SECRET — all 4 required together to enable the
//   optional X/Twitter cross-post. See the TWITTER / X CROSS-POST section
//   below for setup details and 2026 pricing notes.
// ============================================================================

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

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

// v7: Optional CoinGecko Demo API key. Without it, every CoinGecko call in
// this script shares CoinGecko's worldwide keyless bucket (5-15 req/min,
// shared with everyone on the internet not using a key). A free, no-card
// "Demo" key (register at coingecko.com/en/developers/dashboard) moves you
// onto a dedicated per-account bucket instead — as of 2026 that's 100
// req/min, not shared with anyone else. This script only ever makes 3
// CoinGecko calls per run, so either bucket is technically "enough" most
// days — the point of the key isn't more requests, it's not depending on
// how many *other* people are hammering the shared bucket at 08:30 UTC.
// getMarketData() is the one call every single template/style depends on
// (main() throws if it fails), so this is the single highest-leverage
// reliability fix available in the pipeline.
// v7: Read live from process.env rather than capturing once at module load —
// keeps this testable in both directions (with/without a key set) without
// needing to reload the module, and costs nothing at runtime since this is
// called at most 3 times per script run.
const COINGECKO_API_KEY_ENV = "COINGECKO_API_KEY";

function coingeckoHeaders() {
  const key = process.env[COINGECKO_API_KEY_ENV];
  return key ? { "x-cg-demo-api-key": key } : {};
}
// v5: "Binance ticker error: 451" isn't a bug in this script — it's Binance
// returning HTTP 451 ("restricted location") to api.binance.com because
// GitHub Actions runners sit on US/Azure cloud IP ranges that Binance
// treats as restricted for its main api.binance.com domain, regardless of
// where you personally are. This is a widely-reported, Binance-side block
// (see github.com/binance/binance-public-data and Binance's own dev forum),
// not something fixable from our end on that domain.
// Binance separately publishes data-api.binance.vision specifically for
// unauthenticated, read-only public market data (same shape of response,
// no API key). It's documented as the recommended base URL for market-data
// -only use cases. Switching to it here because it's the intended fix for
// this exact situation. If GitHub's IP ranges ever get blocked there too,
// getBinanceAnomalies() still fails gracefully (see the try/catch around
// it in main()) — the anomaly template just won't fire that day, same as
// now, everything else in the pipeline is unaffected either way.
const BINANCE_TICKER_URL = "https://data-api.binance.vision/api/v3/ticker/24hr";

// v9.4 FIX: getMarketData() was the only fetcher in this file with a
// per-attempt timeout (AbortSignal.timeout(15_000)). The 5 supplementary
// fetchers below had none — Node's fetch has no default timeout, so a
// single hung connection to any one of them could stall indefinitely,
// bounded only by GitHub Actions' own job timeout (default 6 hours), not by
// anything in this script. Every fetch() below now passes this signal so a
// stuck source degrades the same way a failing one already does: it's
// caught, logged, and the run moves on with whatever data it has.
const SECONDARY_FETCH_TIMEOUT_MS = 12_000;

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
  "breakout incoming", "short squeeze", "load up", "loading up", "your play",
  "financial advice to buy", "should you buy", "should you sell",
  "sell now", "buy now", "moon", "to the moon", "100x", "get in now",
  // v4.6: Added trade-decision phrases from the Engagement Architect prompt
  // that would nudge readers toward a trade (conflict of interest under
  // Write to Earn, which pays when readers trade off your cashtag).
  "accumulating", "accumulate", "discount", "trap",
  "are you buying", "who's loading", "who is loading",
];

// ===========================================================================
// DATA FETCHERS
// ===========================================================================

// v9.3 FIX: this is the one fetch every code path in the script depends on
// (main() throws if it fails, and nothing catches that throw — unlike every
// other fetcher below, which main() wraps in its own try/catch and treats
// as optional). That made it the single point of failure directly
// contradicting this file's own stated philosophy ("if anything fails, post
// *something* rather than skip a day" — see header comment). A transient
// CoinGecko 429/5xx or a stalled connection used to fail the whole day's
// post outright. Now retried with exponential backoff (2 retries: ~1s, ~2s)
// and a 15s per-attempt timeout so a hung connection can't stall the job
// indefinitely either.
async function getMarketData({ sparkline = false, retries = 2 } = {}) {
  const ids = COINS.map((c) => c.id).join(",");
  const sparklineParam = sparkline ? "&sparkline=true" : "";
  const url = `${COINGECKO_MARKETS_URL}?vs_currency=usd&ids=${ids}&price_change_percentage=24h,7d${sparklineParam}`;

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: coingeckoHeaders(),
        signal: AbortSignal.timeout(15_000),
      });
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
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      const delayMs = 1000 * 2 ** attempt;
      console.log(`  getMarketData: attempt ${attempt + 1} failed (${err.message}), retrying in ${delayMs}ms...`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

// NEW (v2): Trending coins from CoinGecko. Returns the top searched coins,
// filtered to those with market_cap_rank <= 100 so cashtags always resolve
// to real, tradeable, well-known assets (not obscure micro-caps that might
// not even be on Binance).
async function getTrendingCoins() {
  const res = await fetch(COINGECKO_TRENDING_URL, {
    headers: coingeckoHeaders(),
    signal: AbortSignal.timeout(SECONDARY_FETCH_TIMEOUT_MS),
  });
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
  const res = await fetch(COINGECKO_GLOBAL_URL, {
    headers: coingeckoHeaders(),
    signal: AbortSignal.timeout(SECONDARY_FETCH_TIMEOUT_MS),
  });
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
  const res = await fetch(FEAR_GREED_URL, {
    signal: AbortSignal.timeout(SECONDARY_FETCH_TIMEOUT_MS),
  });
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
  const res = await fetch(BINANCE_TICKER_URL, {
    signal: AbortSignal.timeout(SECONDARY_FETCH_TIMEOUT_MS),
  });
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

// NEW (v9): Broad market movers — the same CoinGecko /coins/markets endpoint
// as getMarketData(), but scanning the top 100 coins by market cap instead
// of just the 8-coin COINS watchlist. Powers "digest" (breadth: best/worst
// of 100, how many are green) and "spotlight" (deep-dive on one coin outside
// the usual watchlist) — neither of which the 8-coin watchlist alone can
// answer honestly.
async function getBroadMarketMovers() {
  const url = `${COINGECKO_MARKETS_URL}?vs_currency=usd&order=market_cap_desc&per_page=100&page=1&price_change_percentage=24h`;
  const res = await fetch(url, {
    headers: coingeckoHeaders(),
    signal: AbortSignal.timeout(SECONDARY_FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`CoinGecko broad-movers error: ${res.status}`);
  const rows = await res.json();
  return rows
    .map((d) => ({
      symbol: (d.symbol || "").toUpperCase(),
      name: d.name,
      price: d.current_price,
      change24h: d.price_change_percentage_24h_in_currency ?? d.price_change_percentage_24h,
      volume24h: d.total_volume,
      marketCap: d.market_cap,
      rank: d.market_cap_rank,
      athChangePct: d.ath_change_percentage,
    }))
    .filter((d) => d.change24h !== null && d.change24h !== undefined && !Number.isNaN(d.change24h));
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
  if (n === null || n === undefined) return "n/a";
  // v5: minimumFractionDigits was missing, so toLocaleString silently
  // dropped trailing zeros ($7.90 -> "$7.9") while other coins in the same
  // post kept 2 decimals ($1,772.31), making prices look inconsistently
  // formatted side by side. Always show at least 2 decimals now.
  // v9: 4 max decimals (the pre-v9 limit) rounds any coin under $0.0001 to
  // literally "$0.00" — a materially wrong number, not just a cosmetic
  // rounding choice. This was latent in the original 8-coin watchlist (its
  // cheapest coin, DOGE, never dropped that low) but the v9 "digest" and
  // "spotlight" styles pull from the top-100 market, which regularly
  // includes sub-cent meme coins. Scale precision to magnitude instead of
  // using one fixed cap for every price.
  let maxDecimals;
  if (n > 0 && n < 0.01) {
    maxDecimals = 8;
  } else if (n < 10) {
    maxDecimals = 4;
  } else {
    maxDecimals = 2;
  }
  return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: maxDecimals })}`;
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
  // v9.4 FIX: data[dayIndex % data.length] is data[NaN] -> undefined when
  // data is empty (dayIndex % 0 is NaN), which then threw on coin.symbol
  // below — an uncaught crash instead of the graceful per-day fallback this
  // file's header explicitly promises ("if anything fails, post *something*
  // rather than skip a day"). Returning null here lets main()'s existing
  // fallback chain (template -> snapshot -> throw) do what it already does
  // for every other template that can't be built from today's data.
  if (!data || data.length === 0) return null;
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
  // v9.4 FIX: same empty-data guard as buildEducationalPost — see the
  // comment there. data[dayIndex % data.length] is unsafe when data is [].
  if (!data || data.length === 0) return null;

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

// ---------------------------------------------------------------------------
// NEW (v9): Top Movers Digest — scans the top 100 coins by market cap (not
// just the 8-coin core watchlist) for the single best gainer and worst
// loser, plus a breadth stat (how many of the 100 are green today). Only 2
// cashtags, well under MAX_CASHTAGS_PER_POST, leaving room for the breadth
// line.
// ---------------------------------------------------------------------------
function buildTopMoversDigestPost(broadMovers) {
  if (!broadMovers || broadMovers.length === 0) return null;
  let gainer = null;
  let loser = null;
  let greenCount = 0;
  for (const d of broadMovers) {
    if (d.change24h >= 0) greenCount++;
    if (!gainer || d.change24h > gainer.change24h) gainer = d;
    if (!loser || d.change24h < loser.change24h) loser = d;
  }
  if (!gainer || !loser) return null;
  return [
    "\uD83D\uDCC8 Top Movers Digest (top 100 by market cap)",
    `Best 24h: $${gainer.symbol} ${fmtPct(gainer.change24h)}, now ${fmtPrice(gainer.price)}.`,
    `Worst 24h: $${loser.symbol} ${fmtPct(loser.change24h)}, now ${fmtPrice(loser.price)}.`,
    `Breadth: ${greenCount}/${broadMovers.length} of the top 100 are green today.`,
    "",
    "Market breadth, not a trade signal. Always DYOR.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// NEW (v9): Market Spotlight — deep-dive on the single biggest 24h mover
// among the top 100 that ISN'T already one of the 8 core watchlist coins,
// so this style surfaces genuinely new names instead of re-covering
// BTC/ETH/etc. every time. Falls back to the single biggest mover overall
// if every top mover happens to already be in the core watchlist.
// ---------------------------------------------------------------------------
function buildMarketSpotlightPost(broadMovers) {
  if (!broadMovers || broadMovers.length === 0) return null;
  const coreSymbols = new Set(COINS.map((c) => c.symbol));
  const sorted = [...broadMovers].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
  const spotlight = sorted.find((d) => !coreSymbols.has(d.symbol)) || sorted[0];
  if (!spotlight) return null;
  const direction = spotlight.change24h >= 0 ? "up" : "down";
  const athLine = (spotlight.athChangePct !== null && spotlight.athChangePct !== undefined)
    ? ` It's ${fmtPct(spotlight.athChangePct)} from its all-time high.`
    : "";
  return [
    `\uD83D\uDD26 Market Spotlight: $${spotlight.symbol} (${spotlight.name})`,
    `Rank #${spotlight.rank ?? "n/a"} by market cap, ${direction} ${Math.abs(spotlight.change24h).toFixed(2)}% in 24h to ${fmtPrice(spotlight.price)}.`,
    `24h volume: ${fmtMcap(spotlight.volume24h)}.${athLine}`,
    "",
    "One coin's numbers, not a recommendation. Always DYOR.",
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

// v5.6: Vibe adherence check. The diagnostic showed the model silently
// dropping the vibe instruction (told Range Watcher, wrote a 7d comparison
// with zero range content). Nothing validated whether the vibe was actually
// followed — cashtags, disclaimer, and length all get checked, but the vibe
// was a "hope it sticks" instruction buried under 15 other constraints.
//
// This function checks whether the output actually reflects the active vibe.
// Returns true if followed, or { reason: "..." } if not. Called from
// isSafeAiText when a vibeName is provided (optional — tests skip it).
//
// Checks are deliberately keyword-based (not semantic) — fast, deterministic,
// no extra API call. They look for evidence the model addressed the vibe's
// core ask, not perfect compliance.
function checkVibeAdherence(text, vibeName) {
  if (!vibeName) return true; // no vibe to check — always passes
  const lower = text.toLowerCase();

  switch (vibeName) {
    case "Plain Update":
      // No specific requirement — "state the facts directly" always passes.
      return true;

    case "Comparison": {
      // Must contain a contrast indicator — either a contrast word, or
      // two coins moving in opposite directions (one "up" + one "down").
      const contrastWords = [
        "while", "but", "unlike", "vs", "versus", "compared",
        "outpacing", "outpaced", "trails", "leads", "ahead", "behind",
        "diverge", "diverging", "opposite", "contrast", "whereas",
        "meanwhile", "split", "mixed",
      ];
      const hasContrastWord = contrastWords.some((w) => lower.includes(w));
      const hasBothDirections = lower.includes("up") && lower.includes("down");
      if (!hasContrastWord && !hasBothDirections) {
        return { reason: "Comparison vibe requires a contrast (e.g. 'while', 'but', 'unlike', or one coin up + one down). Add an actual contrast between two data points." };
      }
      return true;
    }

    case "Range Watcher": {
      // Must mention range-related terms — the data includes "24h range $X–$Y"
      // so the model should reference the high/low or where price sits in range.
      // v5.6 fix: "high" and "low" as bare substrings false-positive on
      // "higher" and "lower" (which are about price direction, not range).
      // Use specific phrases instead: "24h high", "high of", "high end", etc.
      const rangeTerms = [
        "range", "between", "band", "trading between",
        "near the", "toward the", "24h high", "24h low",
        "session high", "session low", "intraday",
        "high of", "low of", "high end", "low end",
      ];
      const hasRangeTerm = rangeTerms.some((w) => lower.includes(w));
      if (!hasRangeTerm) {
        return { reason: "Range Watcher vibe requires mentioning the 24h range, high, low, or where the price sits within its range. The DATA includes '24h range $X–$Y' — reference it." };
      }
      return true;
    }

    case "Volume Lens": {
      // Must mention volume — the data includes "24h volume $X.XB".
      const hasVolume = lower.includes("volume") || lower.includes("vol ");
      if (!hasVolume) {
        return { reason: "Volume Lens vibe requires mentioning trading volume. The DATA includes '24h volume $X.XB' — reference it." };
      }
      return true;
    }

    case "Contrarian Question": {
      // Must end with a question mark — the vibe instruction says "end with
      // a curiosity question." If there's no question, the vibe wasn't followed.
      // (Banned-phrase check already catches trade questions like "are you buying".)
      if (!text.trim().endsWith("?")) {
        return { reason: "Contrarian Question vibe requires ending with a curiosity question (must end with '?')." };
      }
      return true;
    }

    default:
      return true; // unknown vibe — don't block
  }
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
//
// v5.6: Added optional vibeName parameter. When provided, checks vibe
// adherence (did the model actually follow the vibe instruction?). Vibe
// failures are retryable — the corrective retry tells the model exactly
// what vibe requirement it missed.
function isSafeAiText(text, allowedSymbols, vibeName) {
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
    // v5: added after seeing the model close a data-rich post with a
    // generic volume namecheck instead of an actual comparison — these
    // restate that a big coin has big volume/attention, which is true
    // every single day and isn't a real observation about today's data.
    "seeing significant volume",
    "significant 24h volume",
    "significant trading volume",
    "notable volume",
    "seeing significant",
  ];
  for (const phrase of FILLER_PHRASES) {
    if (lower.includes(phrase)) {
      return { ok: false, reason: `filler phrase "${phrase}"`, retryable: false };
    }
  }

  // v5: Regex catch for volume/market-cap SIZE comparisons ("$ETH has a
  // smaller 24h volume than $BTC", "$BTC has a bigger market cap than
  // $LINK"). Exact-substring filler matching misses these because of the
  // variable words in between ("smaller 24h volume than", "smaller
  // volume compared to"). These comparisons are almost always true
  // regardless of the day's actual numbers (BTC outranks ETH outranks
  // LINK in size basically every day), so they read as an "insight" but
  // aren't really about today's data — same underlying problem as the
  // filler phrases above, just structured as a comparison instead of a
  // single adjective.
  const SIZE_COMPARISON_RE = /\b(smaller|larger|bigger|higher|lower|more|less)\b[^.]{0,25}\b(volume|market cap)\b/i;
  if (SIZE_COMPARISON_RE.test(trimmed)) {
    return { ok: false, reason: "volume/market-cap size comparison (near-permanent ranking, not an observation about today) — compare 24h/7d percent changes instead", retryable: false };
  }

  // Banned phrases (trading suggestions) — not retryable.
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) {
      return { ok: false, reason: `banned phrase "${phrase}"`, retryable: false };
    }
  }

  // v5.6: Vibe adherence check. If a vibeName was provided, verify the
  // output actually follows the vibe instruction. This is the check that
  // was missing — the model could silently drop the vibe and nothing would
  // catch it. Vibe failures are retryable (the corrective retry tells the
  // model exactly what vibe requirement it missed).
  if (vibeName) {
    const vibeResult = checkVibeAdherence(trimmed, vibeName);
    if (vibeResult !== true) {
      return { ok: false, reason: `vibe "${vibeName}" not followed: ${vibeResult.reason}`, retryable: true };
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
// v5.6: Added vibeName parameter, passed through to isSafeAiText for
// vibe adherence checking.
//
// Retry only happens when isSafeAiText returns retryable: true. Network
// errors, rate limits (429), and non-retryable validation failures (banned
// phrases, filler, length, missing DYOR) skip the retry and move directly
// to the next provider.
async function callAiWithFallback(prompt, allowedSymbols, vibeName) {
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
    let validation = isSafeAiText(cleaned, allowedSymbols, vibeName);

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
      const retryValidation = isSafeAiText(retryCleaned, allowedSymbols, vibeName);

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
// v7: Disclaimer rotation. Every AI post previously closed on the identical
// literal string "Not financial advice. DYOR." — same substance every time,
// but it's also the strongest monotony signal in the whole post (identical
// last line, every day, regardless of vibe). Rotating the wording keeps the
// same legal/compliance meaning (still says "not advice, do your own
// research" every time) while removing that one guaranteed repetition.
// isSafeAiText() requires the output to contain "dyor" or "not financial
// advice" (case-insensitive) — every variant below satisfies that check, so
// this doesn't loosen the compliance gate at all, just varies its wording.
const DISCLAIMER_VARIANTS = [
  "Not financial advice. DYOR.",
  "NFA. Always DYOR.",
  "Not financial advice — do your own research.",
];

async function buildAiPost(data, dayIndex, style, ctx = {}) {
  const { globalMarket, fng, anomalies, trending, broadMovers } = ctx;

  // v4.6: Vibe rotation — cycles through 5 tonal angles independently of the
  // template rotation. Adds tonal variety on top of structural variety so
  // two "snapshot" posts a week apart don't read the same.
  //
  // Inspired by the "Engagement Architect" prompt pattern, but with CTAs
  // rewritten to ask curiosity questions ("which one are you watching?")
  // instead of trade-decision questions ("are you buying?"). The latter
  // would violate the banned-phrases rule and Binance's creator guidance,
  // since Write to Earn pays when readers trade — nudging toward a trade
  // is a conflict of interest.
  const VIBES = [
    {
      name: "Plain Update",
      instruction: "State the facts directly. No spin, no angle. Let the numbers speak.",
    },
    {
      name: "Comparison",
      // v5.5: Added fallback — Comparison needs price-change data to actually
      // compare. When paired with data-poor templates (trending only has
      // rank, no prices), fall back to comparing ranks or search-interest
      // positioning instead of forcing a price comparison that doesn't exist.
      instruction: "Find the most interesting contrast in the data. If price changes are available, contrast two coins' moves. If only ranks are available (trending data), contrast the rank positioning or search-interest context instead. Lead with whatever contrast the data actually supports.",
    },
    {
      name: "Range Watcher",
      // v5.5: Added fallback — Range Watcher needs 24h high/low to observe
      // where prices sit. If range data isn't available, fall back to noting
      // the 24h change magnitude or ATH distance instead.
      instruction: "Focus on where prices are within their recent range. If 24h high/low is in the data, note where current price sits in that range. If range data isn't available, fall back to noting the 24h change magnitude or distance from all-time high. Don't predict breakouts — just observe where things sit.",
    },
    {
      name: "Volume Lens",
      instruction: "If volume data is available, note whether high-volume coins are moving on that volume or not. If no volume data, fall back to Plain Update.",
    },
    {
      name: "Contrarian Question",
      instruction: "End with a curiosity question that asks what readers are watching, without suggesting they should buy or sell. E.g. 'Which one are you keeping an eye on?'",
    },
  ];
  // v5.5: Vibe index uses dayIndex % 5. Template rotation (in main()) now
  // uses a 7-entry array, so the two are coprime — 5×7=35 unique (vibe,
  // template) pairings occur over 35 days instead of 5 over 5. Previously
  // both used % 5, which locked them in a fixed 1:1 correspondence (every
  // macro post was always Plain Update, every trending always Comparison,
  // etc.) — the vibe system added zero cross-variety despite the comment
  // claiming independence.
  const vibe = VIBES[dayIndex % VIBES.length];
  const disclaimer = DISCLAIMER_VARIANTS[dayIndex % DISCLAIMER_VARIANTS.length];

  // v4.1: Each style now has its own directive + example post.
  // v4.2: Examples now use $COIN1/$COIN2/$COIN3 placeholders instead of real
  // tickers. Previously, the model was copying example cashtags (BTC, ETH, BNB)
  // alongside the actual data symbols, producing 6 cashtags when max is 3.
  // These placeholders don't match the cashtag regex ($[A-Z]{2,6}\b — note
  // the digit prevents a word boundary match), so even if the model copies
  // them, they won't be counted as cashtags by validation.
  const styleConfig = {
    snapshot: {
      // v5.5: Softened the "7d comparison as CENTERPIECE" mandate. It was
      // too rigid — when Range Watcher or Volume Lens is the active vibe,
      // forcing a 7d comparison as the centerpiece overrides the vibe
      // instruction (which is exactly what Day 7's diagnostic showed: told
      // Range Watcher, wrote a 7d comparison). Now the 7d comparison is
      // "available, use if it fits the vibe" instead of "mandatory centerpiece."
      directive: "Write this as real prose, not a data export. Do NOT just stack '$COIN price (change%) · $COIN price (change%)' back to back — weave each coin's numbers into actual sentences. The data includes 24h change, 7d change, 24h range, volume, and ATH distance — pick whichever angles fit today's vibe instruction. If the vibe calls for range observation, use the 24h high/low. If it calls for comparison, contrast two coins' 7d moves. Don't force the same angle every day. Do NOT compare volume or market cap size between coins — that ordering barely changes day to day.",
      example: "$COIN1 is holding close to flat at $7.91 today, while $COIN2 ($63,199) and $COIN3 ($1,776.83) both push higher, up 0.81% and 0.98%. The bigger story is the week: $COIN3 is up 12.4% over 7 days, more than double $COIN2's 7-day gain. Not financial advice. DYOR.",
    },
    mover: {
      directive: "Lead with the coin that moved most. State the move and current price in one sentence. Add one line of neutral context using at least two of: volume, 24h high/low range, 7-day change, ATH distance — whatever the data provides and the vibe emphasizes. Don't speculate on why it moved.",
      example: "Today's biggest mover: $COIN1 at $123, up 5.4% in 24h on $4.5B volume. Traded between $118 and $126 today, and is up 11% over the past week. Not financial advice. DYOR.",
    },
    educational: {
      directive: "Explain ONE crypto concept in plain language in 2 sentences. Then mention one coin's current price as a concrete example. Don't list multiple concepts — pick one and explain it well. The concept is the main content; the price is just a concrete anchor.",
      example: "Market cap = price × circulating supply. It values coins already in circulation, not future token unlocks. For context, $COIN1 at $67,234 has a market cap around $1.3T. Not financial advice. DYOR.",
    },
    macro: {
      directive: "Give the big picture in 2 sentences: total market cap + BTC dominance + (if available) sentiment. Mention one featured coin briefly. Don't list every number — pick the 2-3 that tell the story and let the vibe guide which angle to emphasize.",
      example: "Total crypto market cap sits at $2.28T with dominance concentrated in the top asset. Fear & Greed at 24/100 (extreme fear). $COIN1 at $67,234 holding above recent lows. Not financial advice. DYOR.",
    },
    anomaly: {
      directive: "State the unusual move(s) factually — coin, direction, magnitude, in one sentence per coin. Add one line noting this is notable without interpreting it as a trade setup. Maximum 3 coins.",
      example: "Unusual 24h moves: $COIN1 +12.3% (vol $4.5B), $COIN2 -8.5% (vol $2.1B). Both moves stand out against an otherwise quiet watchlist. Not financial advice. DYOR.",
    },
    trending: {
      // v5.5: Acknowledged that trending data only has symbol/name/rank —
      // no prices or changes. The directive now tells the model to work
      // with what's actually there (rank positioning, search-interest context)
      // instead of implying price data exists.
      directive: "List what's trending on CoinGecko right now. The data only includes symbol, name, and market cap rank — no prices or price changes. Work with what's there: rank positioning, name recognition, search-interest context. Don't invent prices or changes. One compact line listing the coins, then one sentence of context for why these might be getting attention (without speculating on price direction).",
      example: "Trending on CoinGecko: $COIN1 (rank #5), $COIN2 (rank #1), $COIN3 (rank #10). Search interest spiking across both established names and newer entrants. Not financial advice. DYOR.",
    },
    sentiment: {
      directive: "State the Fear & Greed reading and what it means. One sentence on what this extreme historically coincides with — without framing it as a buy/sell signal. Mention one coin's price as an anchor.",
      example: "Fear & Greed Index at 24/100 — extreme fear territory. Historically this reading has coincided with capitulation and high volatility, not a directional signal by itself. $COIN1 at $67,234. Not financial advice. DYOR.",
    },
    digest: {
      // v9: Report on breadth across the top 100 coins, not just the 8-coin
      // watchlist. The point is contrast: one great day + one bad day + how
      // widely that's shared, not a laundry list of names.
      directive: "Report on market breadth using the top-100 digest data: the best 24h gainer, the worst 24h loser, and how many of the top 100 coins are green today. State what the breadth number implies about how broad-based today's moves are — don't just list the three numbers with no connective point.",
      example: "$COIN1 leads the top 100 today at +9.2%, while $COIN2 lags at -6.1%. 62 of the top 100 are green — a broadly positive day, not just one or two names carrying it. Not financial advice. DYOR.",
    },
    spotlight: {
      // v9: Deliberately a single name OUTSIDE the core watchlist — the
      // whole point is surfacing something the reader isn't already seeing
      // in every other post.
      directive: "Spotlight ONE coin from outside the usual watchlist — its market cap rank, 24h move, volume, and (if available) distance from all-time high. This is a deep dive on a single name the reader probably isn't already tracking, not a comparison to other coins.",
      example: "$COIN1 (rank #34) is up 14.8% in 24h to $2.31 on $310M volume — still 71% below its all-time high. A name outside the usual watchlist worth a second look. Not financial advice. DYOR.",
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
      dataLines.push(`${best.symbol}: ${fmtPrice(best.price)}, 24h change ${fmtPct(best.change24h)}, 7d change ${fmtPct(best.change7d)}, 24h volume ${fmtMcap(best.volume24h)}, 24h range ${fmtPrice(best.low24h)}\u2013${fmtPrice(best.high24h)}, ${fmtPct(best.athChangePct)} from all-time high`);
    }
  } else if (style === "digest" && broadMovers && broadMovers.length > 0) {
    // v9: top-100 breadth — best gainer, worst loser, green count. Only 2
    // cashtags so CASHTAGS instruction below stays a "use at least 2" case.
    let gainer = null;
    let loser = null;
    let greenCount = 0;
    for (const d of broadMovers) {
      if (d.change24h >= 0) greenCount++;
      if (!gainer || d.change24h > gainer.change24h) gainer = d;
      if (!loser || d.change24h < loser.change24h) loser = d;
    }
    if (gainer && loser) {
      allowedSymbols.push(gainer.symbol, loser.symbol);
      dataLines.push(`Best 24h in top 100: ${gainer.symbol}, ${fmtPct(gainer.change24h)}, price ${fmtPrice(gainer.price)}`);
      dataLines.push(`Worst 24h in top 100: ${loser.symbol}, ${fmtPct(loser.change24h)}, price ${fmtPrice(loser.price)}`);
      dataLines.push(`Breadth: ${greenCount} of ${broadMovers.length} top-100 coins are green today`);
    }
  } else if (style === "spotlight" && broadMovers && broadMovers.length > 0) {
    // v9: pick the biggest mover OUTSIDE the core watchlist so this style
    // always surfaces a name other templates aren't already covering.
    const coreSymbols = new Set(COINS.map((c) => c.symbol));
    const sorted = [...broadMovers].sort((a, b) => Math.abs(b.change24h) - Math.abs(a.change24h));
    const spotlight = sorted.find((d) => !coreSymbols.has(d.symbol)) || sorted[0];
    if (spotlight) {
      allowedSymbols.push(spotlight.symbol);
      dataLines.push(`${spotlight.symbol} (${spotlight.name}): rank #${spotlight.rank ?? "n/a"}, ${fmtPct(spotlight.change24h)} 24h, price ${fmtPrice(spotlight.price)}, volume ${fmtMcap(spotlight.volume24h)}, ${fmtPct(spotlight.athChangePct)} from all-time high`);
    }
  } else {
    // Default: snapshot-style with the core watchlist. v5: added 7d change
    // and 24h volume so each coin carries more than 2 raw numbers.
    // v5.5: Added 24h range (high/low) so Range Watcher vibe — which can now
    // pair with snapshot thanks to the decoupled rotation — actually has
    // range data to observe instead of falling back every time.
    const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
    for (const d of featured) {
      allowedSymbols.push(d.symbol);
      dataLines.push(`${d.symbol}: ${fmtPrice(d.price)}, 24h change ${fmtPct(d.change24h)}, 7d change ${fmtPct(d.change7d)}, 24h range ${fmtPrice(d.low24h)}\u2013${fmtPrice(d.high24h)}, 24h volume ${fmtMcap(d.volume24h)}, ${fmtPct(d.athChangePct)} from all-time high`);
    }
  }

  if (allowedSymbols.length === 0 || dataLines.length === 0) return null;

  // v4.6: Log the vibe so it shows in the Stage 3 log
  console.log(`  Vibe: "${vibe.name}" (day ${dayIndex} mod ${VIBES.length})`);

  // v4.6: Restructured prompt with hook/body/CTA format and vibe rotation.
  // Integrates the "Engagement Architect" pattern (structure + vibes + length
  // target + emoji budget) while keeping the safety system intact (banned
  // phrases, filler detection, ungrounded-name check, 3-cashtag max).
  // v5: Kept the richer data fields, Binance Vision API, expanded watchlist,
  // minimumFractionDigits fix, size-comparison regex, and rewritten
  // snapshot/mover directives from the uploaded v5 file.
  // v5.4: Context-aware CTA. The diagnostic showed "Which one are you watching?"
  // appearing in 4/5 posts and being grammatically wrong for single-coin posts
  // (Day 3's mover) and incoherent for educational posts (Day 4's "Which $DOGE
  // move" tacked onto a market-cap definition). Now picks the CTA based on
  // what actually fits the post shape.
  let ctaInstruction;
  if (style === "educational") {
    // Educational posts end with the concept + example price. A CTA tacked on
    // doesn't fit — Day 4 proved this. Drop it entirely.
    ctaInstruction = "- CTA: Skip. Educational posts end after the concept and example. Do not tack a question on.";
  } else if (allowedSymbols.length === 1) {
    // Single-coin posts (mover) — "which one" is grammatically wrong when
    // there's only one. Use a single-coin CTA instead.
    const onlyCoin = allowedSymbols[0];
    ctaInstruction = `- CTA (optional): End with a curiosity question about $${onlyCoin} specifically, e.g. "What's your read on $${onlyCoin} today?" — NOT "which one" (there's only one). NOT a trade question.`;
  } else {
    // Multi-coin posts — the standard curiosity CTA fits.
    ctaInstruction = `- CTA (optional): End with a curiosity question like 'Which one are you watching?' — NOT a trade question like 'are you buying?'.`;
  }

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
      : `CASHTAGS: Use $TICKER for at least 2 of: ${allowedSymbols.map((s) => "$" + s).join(", ")}. Max ${MAX_CASHTAGS_PER_POST} unique coins. Use ONLY these symbols — no others.`,
    "",
    "STRUCTURE (follow this):",
    "- HOOK: One sentence that grabs attention — a surprising number, a contrast, or a direct question.",
    "- BODY: 1-2 sentences with the key facts from DATA. Dense, no filler.",
    ctaInstruction,
    `- DISCLAIMER: End with exactly this line: ${disclaimer}`,
    "",
    "STYLE RULES:",
    "- 2-4 sentences total. Target 150-300 characters. Short and dense beats long and repetitive.",
    "- If DATA includes a distance from all-time high, that's a genuinely different number every day (unlike 24h/7d change, which you've likely used in a similar shape before) — it's a good candidate for the HOOK or CTA on days when it's notably far from or close to the ATH. Don't force it if it doesn't fit.",
    "- Do NOT repeat information. If you said the rank, don't say 'ranking well'.",
    "- Do NOT use filler phrases: 'making appearances', 'continues to see', 'needs no introduction', 'it's worth noting', 'are trading'.",
    "- Do NOT describe what the numbers already show. Don't say 'maintaining its position' — the rank shows that.",
    "- Do NOT close with a vague volume/attention observation like 'seeing significant volume' or 'notable volume' — a big coin having big volume is true every day and says nothing. Any closing line must be a specific comparison that's only true because of TODAY'S numbers.",
    "- Up to 3 emojis allowed (optional). Use sparingly — only if they add meaning, not decoration.",
    "- No trading suggestions, predictions, or hype words. No 'buy', 'sell', 'accumulating', 'loading up', 'discount', 'trap'.",
    "",
    `EXAMPLE (${style} style — match this density, don't copy the words):`,
    config.example,
    "",
    "The EXAMPLE shows format only. Its $COIN1/$COIN2/$COIN3 are placeholders — do NOT use them. Use ONLY the real symbols from DATA above.",
    "Do not name any coin, by symbol or full name (e.g. Bitcoin, Ethereum), that isn't in DATA above — even if it's true in general, if it's not in today's data it doesn't belong in this post.",
    "",
    // v5.6: Vibe instruction moved to the END of the prompt (recency bias).
    // Previously it was at position 2, buried under DATA/CASHTAGS/STRUCTURE/
    // STYLE RULES/EXAMPLE — by the time the model generated, the vibe was
    // far away and got silently dropped (the diagnostic showed Range Watcher
    // producing output with zero range content). Now it's the last thing
    // the model reads before generating, which is the highest-leverage
    // position for instruction-following.
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "BEFORE YOU WRITE — today's vibe is the ANGLE of your post. Follow it:",
    `VIBE: "${vibe.name}" — ${vibe.instruction}`,
    "Your output MUST reflect this vibe. If it doesn't, it will be rejected.",
    "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
    "",
    "Output ONLY the post text. No preamble, no quotes, no markdown.",
  ].join("\n");

  // v4: Use multi-provider fallback chain instead of single Gemini call.
  // callAiWithFallback tries Groq → OpenAI → Gemini, returns { text, provider }
  // or null if all fail. Validation runs inside the chain on each provider's output.
  // v5.6: Pass vibe.name so isSafeAiText can check vibe adherence.
  const result = await callAiWithFallback(prompt, allowedSymbols, vibe.name);
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
    case "digest":
      return buildTopMoversDigestPost(ctx.broadMovers);
    case "spotlight":
      return buildMarketSpotlightPost(ctx.broadMovers);
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
// TWITTER / X CROSS-POST (NEW v9, optional)
// ---------------------------------------------------------------------------
// Cross-posts the SAME text this script just posted to Binance Square, to
// X/Twitter, from the SAME account this bot already speaks for. This is
// syndicating one voice to a second platform — not a way to simulate a
// second, independent voice.
//
// Posting to X requires user-context auth (OAuth 1.0a or OAuth 2.0 PKCE) —
// as of 2026 a plain app-only bearer token cannot post via POST /2/tweets,
// so this signs each request with OAuth 1.0a using four secrets from your
// X developer app (Keys and Tokens tab, app permissions set to "Read and
// Write"):
//   TWITTER_API_KEY             (Consumer Key)
//   TWITTER_API_SECRET          (Consumer Secret)
//   TWITTER_ACCESS_TOKEN
//   TWITTER_ACCESS_TOKEN_SECRET
//
// Skips gracefully (no error, no throw) if any of the four is missing, so
// this is fully optional and never blocks the Binance Square post — that
// post is the primary output; X is a bonus.
//
// Note on cost: X moved new developer accounts to pay-per-use pricing in
// Feb 2026 (on the order of $0.01/post at time of writing) — unlike the
// rest of this project's stack, this is not guaranteed free. Check your
// own X developer dashboard before enabling it.
// ===========================================================================

const TWITTER_POST_URL = "https://api.x.com/2/tweets";

// RFC 3986 percent-encoding — encodeURIComponent leaves !*'() unescaped,
// which OAuth 1.0a's signature spec requires to be escaped. Without this,
// signatures silently mismatch for any text containing those characters.
function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// Builds a valid OAuth 1.0a Authorization header for a POST request. X's
// v2 endpoints sign only the oauth_* params (not the JSON body) — this
// matches X's documented OAuth 1.0a flow for POST /2/tweets. nonce/timestamp
// are injectable so tests can assert a deterministic signature; production
// calls (below) omit them and get fresh random/current values each time.
function buildOAuth1Header(url, consumerKey, consumerSecret, token, tokenSecret, nonce, timestamp) {
  const oauthParams = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: nonce || crypto.randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: timestamp || Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
  };

  const paramString = Object.keys(oauthParams)
    .sort()
    .map((k) => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join("&");

  const baseString = ["POST", percentEncode(url), percentEncode(paramString)].join("&");
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  const headerParams = { ...oauthParams, oauth_signature: signature };
  return "OAuth " + Object.keys(headerParams)
    .sort()
    .map((k) => `${percentEncode(k)}="${percentEncode(headerParams[k])}"`)
    .join(", ");
}

async function postToTwitter(text) {
  const consumerKey = process.env.TWITTER_API_KEY;
  const consumerSecret = process.env.TWITTER_API_SECRET;
  const token = process.env.TWITTER_ACCESS_TOKEN;
  const tokenSecret = process.env.TWITTER_ACCESS_TOKEN_SECRET;

  if (!consumerKey || !consumerSecret || !token || !tokenSecret) {
    console.log("  Twitter cross-post: skipped (TWITTER_* secrets not fully configured).");
    return null;
  }

  if (isDryRun()) {
    console.log("  [DRY RUN] Twitter cross-post: would post, but DRY_RUN is set — skipping.");
    return null;
  }

  // X posts cap at 280 chars; Square posts can run up to 1500. Hard-truncate
  // with an ellipsis as a last resort so a cross-post never fails purely on
  // length — the full text is already safely on Square regardless.
  const tweetText = text.length <= 280 ? text : text.slice(0, 277) + "...";

  const authHeader = buildOAuth1Header(TWITTER_POST_URL, consumerKey, consumerSecret, token, tokenSecret);
  const res = await fetch(TWITTER_POST_URL, {
    method: "POST",
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ text: tweetText }),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Twitter API error: ${data.detail || data.title || res.status}`);
  }
  return data.data?.id || null;
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
// WEEKLY ARTICLE — DRAFT / PUBLISH MODES (v8)
// ---------------------------------------------------------------------------
// v3 through v7 had the Sunday article build itself and publish itself in
// the same step, with dry_run as the only brake. That's backwards for the
// one piece of content in this whole pipeline worth a human's attention —
// this project's own strategic analysis named the weekly article as "the
// lever that actually clears the ceiling," and nothing was built to let a
// human pull that lever before it went out.
//
// These two modes split "write it" from "publish it," with a human edit
// possible in between, and no PC required:
//
//   RUN_MODE=weekly-draft   Gathers data, builds the article + a chart
//                           PREVIEW url (a GET link, not an upload — costs
//                           nothing and needs no Binance key), and writes
//                           both to a JSON file. Makes zero Binance API
//                           calls. weekly-article-draft.yml turns that file
//                           into a GitHub Issue, editable from the GitHub
//                           mobile app like any other text field.
//
//   RUN_MODE=weekly-publish Reads a JSON file containing the issue's
//                           CURRENT body (however a human left it) after
//                           weekly-article-publish.yml extracts it — this
//                           only runs once a human adds the
//                           `approved-for-posting` label. Regenerates the
//                           chart for the SAME dayIndex used at draft time
//                           (so the coins in the image match the coins in
//                           the text), uploads it for real, and publishes.
//
// Publish mode deliberately does NOT fall back to a chart-only or
// plain-text post on failure the way the old ladder did. A human already
// approved specific words; silently substituting different content on
// failure would defeat the point of asking for approval. It fails loudly
// instead, so the workflow shows red and the person can just re-run it.
// ===========================================================================

const DRAFT_ISSUE_MARKER_START = "<!-- weekly-article-draft:start -->";
const DRAFT_ISSUE_MARKER_END = "<!-- weekly-article-draft:end -->";

// Unlike renderChartPng() (which POSTs and returns PNG bytes for uploading),
// QuickChart also serves any chart config via a plain GET url. That's free,
// needs no key, and can be dropped straight into a GitHub Issue's markdown
// as an image preview — so a human reviewing the draft can see the chart
// without this script ever touching the Binance API.
function buildQuickChartPreviewUrl(chartConfig) {
  const encoded = encodeURIComponent(JSON.stringify(chartConfig));
  return `${QUICKCHART_ENDPOINT}?c=${encoded}&backgroundColor=%230B0E11&width=800&height=450`;
}

// Builds the full GitHub Issue body for a draft: plain-language instructions
// first (this is read by a non-developer on a phone), then the chart
// preview, then the actual article between HTML-comment markers. Everything
// between the markers is fair game to edit; parseDraftIssue() below is what
// reads it back after a human has (possibly) changed it.
function buildDraftIssueBody({ title, body, dayIndex, chartPreviewUrl, weekRange }) {
  const lines = [
    `### \uD83D\uDCDD Weekly Article Draft \u2014 ${weekRange}`,
    "",
    "This was auto-generated. **Nothing publishes until you approve it.**",
    "",
    "**To edit (from your phone):** tap the \u22EF menu on this issue \u2192 Edit, and change whatever you like below. Keep the line starting with `#` as the title.",
    "",
    "**To publish** (as-is, or after your edits): add the label `approved-for-posting` to this issue. That's the only thing that actually posts it to Binance Square.",
    "",
    "**To cancel:** do nothing, or close the issue. It never posts on its own.",
    "",
    "There's a hidden line below like `<!-- day_index: 7 -->` \u2014 it just keeps the chart's coin picks matching the text. Fine to leave alone, and fine if it gets deleted by accident; nothing breaks either way.",
    "",
  ];
  if (chartPreviewUrl) {
    lines.push(`![7-day chart preview](${chartPreviewUrl})`, "");
  }
  lines.push(
    "---",
    "",
    DRAFT_ISSUE_MARKER_START,
    `<!-- day_index: ${dayIndex} -->`,
    `# ${title}`,
    "",
    body,
    DRAFT_ISSUE_MARKER_END,
  );
  return lines.join("\n");
}

// Recovers { title, body, dayIndex } from a draft issue body that a human
// may have hand-edited. Deliberately tolerant: the day_index marker is
// optional (falls back to null, and the caller defaults to "today" — losing
// perfect coin-selection consistency isn't worth failing the publish over).
// The title line is NOT optional — without it there's nothing safe to post,
// so this returns null and the publish workflow fails loudly rather than
// guessing.
function parseDraftIssue(issueBody) {
  if (!issueBody) return null;
  const startIdx = issueBody.indexOf(DRAFT_ISSUE_MARKER_START);
  const endIdx = issueBody.indexOf(DRAFT_ISSUE_MARKER_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) return null;

  const inner = issueBody.slice(startIdx + DRAFT_ISSUE_MARKER_START.length, endIdx).trim();

  const dayIndexMatch = inner.match(/<!--\s*day_index:\s*(\d+)\s*-->/);
  const dayIndex = dayIndexMatch ? parseInt(dayIndexMatch[1], 10) : null;

  const withoutMarker = inner.replace(/<!--\s*day_index:\s*\d+\s*-->/, "").trim();
  const titleMatch = withoutMarker.match(/^#\s+(.+)$/m);
  if (!titleMatch) return null;
  const title = titleMatch[1].trim();

  const body = withoutMarker.slice(withoutMarker.indexOf(titleMatch[0]) + titleMatch[0].length).trim();
  if (!title || !body) return null;

  return { title, body, dayIndex };
}

async function runWeeklyDraftMode(dayIndex) {
  console.log(`\n=== WEEKLY DRAFT MODE (day ${dayIndex}) ===`);
  console.log("No Binance calls happen in this mode \u2014 building a draft only.");

  const data = await getMarketData({ sparkline: true });

  let anomalies = null, trending = null, globalMarket = null, fng = null;
  try { anomalies = await getBinanceAnomalies(); } catch (e) { console.log(`Anomaly scan skipped: ${e.message}`); }
  try { trending = await getTrendingCoins(); } catch (e) { console.log(`Trending fetch skipped: ${e.message}`); }
  try { globalMarket = await getGlobalMarket(); } catch (e) { console.log(`Global market fetch skipped: ${e.message}`); }
  try { fng = await getFearGreed(); } catch (e) { console.log(`Fear & Greed fetch skipped: ${e.message}`); }

  const ctx = { globalMarket, fng, anomalies, trending };
  const article = buildWeeklyArticle(data, dayIndex, ctx);
  if (!article) throw new Error("Could not build weekly article draft (missing CoinGecko data).");

  const weekRange = getWeekRange();
  const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
  const chartConfig = buildWeeklyChartConfig(featured);
  const chartPreviewUrl = chartConfig ? buildQuickChartPreviewUrl(chartConfig) : null;

  const issueBody = buildDraftIssueBody({
    title: article.title,
    body: article.body,
    dayIndex,
    chartPreviewUrl,
    weekRange,
  });

  const outFile = process.env.DRAFT_OUTPUT_FILE || "weekly-draft.json";
  fs.writeFileSync(outFile, JSON.stringify({ weekRange, title: article.title, issueBody }, null, 2));
  console.log(`Draft written to ${outFile} (issue body ${issueBody.length} chars).`);
  console.log(`weekly-article-draft.yml will turn this into a GitHub Issue for review.`);
}

async function runWeeklyPublishMode() {
  console.log(`\n=== WEEKLY PUBLISH MODE ===`);
  const key = process.env.BINANCE_SQUARE_OPENAPI_KEY;
  if (!key) throw new Error("Missing BINANCE_SQUARE_OPENAPI_KEY environment variable.");

  const inFile = process.env.ARTICLE_INPUT_FILE || "weekly-draft.json";
  if (!fs.existsSync(inFile)) {
    throw new Error(`${inFile} not found \u2014 the workflow should write the approved issue body here first.`);
  }
  const raw = JSON.parse(fs.readFileSync(inFile, "utf8"));

  const parsed = parseDraftIssue(raw.issueBody);
  if (!parsed) {
    throw new Error("Could not parse the approved issue body \u2014 make sure the title line (starting with '#') is still present.");
  }

  const now = new Date();
  const dayIndex = parsed.dayIndex !== null ? parsed.dayIndex : now.getDate();
  const recoveredNote = parsed.dayIndex === null ? " (recovered \u2014 day_index marker was missing)" : "";
  console.log(`Publishing "${parsed.title}" (dayIndex ${dayIndex}${recoveredNote})`);

  const data = await getMarketData({ sparkline: true });
  const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
  const chartConfig = buildWeeklyChartConfig(featured);

  let coverImageUrl = null;
  if (chartConfig) {
    try {
      const png = await renderChartPng(chartConfig);
      const tmpFile = path.join(os.tmpdir(), `weekly-chart-${Date.now()}.png`);
      fs.writeFileSync(tmpFile, png);
      coverImageUrl = await uploadImageToSquare(key, tmpFile);
      fs.unlinkSync(tmpFile);
      console.log("Chart rendered and uploaded for article cover image.");
    } catch (err) {
      console.log(`Chart render/upload failed (${err.message}), publishing without cover image.`);
    }
  }

  const id = await postArticleToSquare(parsed.title, parsed.body, coverImageUrl);
  const resultFile = process.env.PUBLISH_RESULT_FILE || "publish-result.json";
  fs.writeFileSync(resultFile, JSON.stringify({ id: id || null, title: parsed.title }, null, 2));

  if (isDryRun()) {
    console.log(`[DRY RUN] No article was actually published.`);
  } else if (id) {
    console.log(`SUCCESS \u2014 posted! View at: https://www.binance.com/square/post/${id}`);
  } else {
    console.log(`Post likely succeeded, but no ID was returned in the response.`);
  }

  // v9: Optional teaser cross-post to X (title + link), same account, same
  // "never block the real post" guarantee as the daily pipeline's cross-post.
  if (id && !isDryRun()) {
    try {
      const teaser = `${parsed.title}\n\nFull article on Binance Square: https://www.binance.com/square/post/${id}`;
      const tweetId = await postToTwitter(teaser);
      if (tweetId) {
        console.log(`Cross-posted teaser to X: https://x.com/i/web/status/${tweetId}`);
      }
    } catch (e) {
      console.log(`Twitter cross-post failed (article above still published): ${e.message}`);
    }
  }
}

// v9.1: Bar chart of 24h % change for the daily post's featured coins.
// Unlike the weekly chart (which uses sparkline data), this uses the
// 24h change percentage already in getMarketData() — no extra API call.
// Renders as a horizontal bar chart: green for up, red for down.
function buildDailyChangeChartConfig(data, dayIndex) {
  const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
  if (featured.length === 0) return null;

  const labels = featured.map((d) => `$${d.symbol}`);
  const values = featured.map((d) => d.change24h || 0);
  const colors = values.map((v) => (v >= 0 ? "#00FFA3" : "#FF4D4F"));

  return {
    type: "horizontalBar",
    data: {
      labels,
      datasets: [{
        data: values,
        backgroundColor: colors,
        borderColor: colors,
        borderWidth: 1,
      }],
    },
    options: {
      title: { display: true, text: "24h Change (%)", fontColor: "#FFFFFF" },
      legend: { display: false },
      scales: {
        xAxes: [{
          ticks: {
            callback: (v) => `${v}%`,
            fontColor: "#AAAAAA",
          },
          gridLines: { color: "#333333" },
        }],
        yAxes: [{
          ticks: { fontColor: "#FFFFFF", fontSize: 14 },
          gridLines: { display: false },
        }],
      },
    },
  };
}

// v9.1: Post text with an optional image attached. If imageUrl is null,
// posts as text-only (same as the original postToSquare). If imageUrl
// is present, sends contentType: 1 with imageList — Binance renders it
// as a text post with an attached image.
async function postToSquareWithOptionalImage(text, imageUrl) {
  const key = process.env.BINANCE_SQUARE_OPENAPI_KEY;
  if (!key) {
    throw new Error("Missing BINANCE_SQUARE_OPENAPI_KEY environment variable.");
  }
  const safeText = enforceMaxLength(text);

  if (isDryRun()) {
    console.log(`=== DRY RUN (TEXT POST${imageUrl ? " + IMAGE" : ""}) — not posting ===`);
    console.log(`Payload contentType: 1`);
    console.log(`Payload bodyTextOnly (${safeText.length} chars):`);
    console.log(safeText);
    if (imageUrl) console.log(`Payload imageList: [${imageUrl}]`);
    console.log(`=== END DRY RUN ===`);
    return null;
  }

  const payload = {
    contentType: CONTENT_TYPE_TEXT,
    bodyTextOnly: safeText,
  };
  if (imageUrl) {
    payload.imageList = [imageUrl];
  }
  const data = await publishToSquare(key, payload);
  return data?.id;
}

// ===========================================================================
// MAIN — smart template selection; weekly article handled by separate modes
// ===========================================================================

async function main() {
  const now = new Date();
  // v5.3: DAY_INDEX_OVERRIDE lets you dry-run different days back-to-back
  // to test whether the vibe/template rotation actually produces different
  // output, or whether the model's prior dominates regardless of instruction.
  // Usage: set DAY_INDEX_OVERRIDE=1 (or any integer) in the workflow env or
  // GitHub Actions inputs. Defaults to today's date if unset — zero
  // production risk, the override only exists for local/dry-run diagnostics.
  const dayIndex = process.env.DAY_INDEX_OVERRIDE
    ? parseInt(process.env.DAY_INDEX_OVERRIDE, 10)
    : now.getDate();
  if (process.env.DAY_INDEX_OVERRIDE) {
    console.log(`  [DIAGNOSTIC] DAY_INDEX_OVERRIDE=${dayIndex} (would normally be day ${now.getDate()})`);
  }

  // v8: RUN_MODE dispatch. Unset/"daily" = the original weekday pipeline
  // below. "weekly-draft" and "weekly-publish" are the two halves of the
  // human-in-the-loop weekly article flow — see the big comment above
  // runWeeklyDraftMode(). Neither of them touches the daily pipeline at all.
  const runMode = process.env.RUN_MODE || "daily";
  if (runMode === "weekly-draft") {
    return runWeeklyDraftMode(dayIndex);
  }
  if (runMode === "weekly-publish") {
    return runWeeklyPublishMode();
  }

  const key = process.env.BINANCE_SQUARE_OPENAPI_KEY;
  if (!key) {
    throw new Error("Missing BINANCE_SQUARE_OPENAPI_KEY environment variable.");
  }

  const isSunday = now.getDay() === 0;

  // v9.2 DIAGNOSTIC: "No AI providers configured" has now been reported twice
  // with the person insisting the secrets are set in the repo, and the code
  // reading GROQ_API_KEY/OPENROUTER_API_KEY/GEMINI_API_KEY has been checked
  // line-by-line three times and is correct. That combination points away
  // from a code bug and toward the GitHub side: either the secrets aren't
  // actually reaching this job (e.g. saved under Codespaces/Dependabot
  // instead of Actions, or saved as Environment secrets while this job
  // doesn't declare `environment:`), or a value is set but empty/whitespace
  // (e.g. a trailing newline from a mobile copy-paste). This log line tells
  // the two cases apart WITHOUT ever printing the secret value itself:
  //   "unset"        -> the job never received this var at all (GitHub-side
  //                      scoping problem — wrong secrets tab, or an
  //                      Environment secret with no `environment:` in the
  //                      job, or a fork/PR context that strips secrets)
  //   "empty/blank"  -> the var reached the job but has no real content
  //                      (bad paste — re-save the secret value)
  //   "N chars"      -> genuinely set; if this shows and AI still doesn't
  //                      run, the bug is elsewhere and this comment is wrong
  for (const envKey of ["GROQ_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY"]) {
    const val = process.env[envKey];
    const state = val === undefined ? "unset" : val.trim().length === 0 ? "empty/blank" : `${val.length} chars`;
    console.log(`  [DIAGNOSTIC] ${envKey}: ${state}`);
  }

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

  // v8: Sunday no longer builds-and-publishes an article unattended here.
  // That auto-publish ladder (article+chart → article-only → chart-only →
  // text recap) always found a way to post *something* on Sundays without a
  // human ever seeing it first — exactly backwards for the one weekly piece
  // worth a human's 20-minute edit. weekly-article-draft.yml (RUN_MODE=
  // weekly-draft) now opens a GitHub Issue with the draft on Sunday morning;
  // weekly-article-publish.yml (RUN_MODE=weekly-publish) posts it only once
  // a human adds the `approved-for-posting` label. This daily workflow just
  // steps aside on Sundays so the two don't double-post.
  // v9.3 FIX: this gate used to fire for every runMode, including
  // "top-movers-digest". That workflow runs on its own 14:00 UTC cron
  // (independent of the weekly-article flow that owns Sundays) and was
  // silently no-op'ing every Sunday as a result. Only the plain daily
  // pipeline defers to the Sunday article workflows.
  if (isSunday && runMode === "daily") {
    console.log("Sunday: the weekly article is owned by weekly-article-draft.yml / weekly-article-publish.yml now, not this workflow. Skipping today's daily post.");
    return;
  }

  // ===========================================================================
  // STAGE 1: RESEARCH — gather data from all free sources
  // ===========================================================================
  console.log(`\n=== STAGE 1: RESEARCH (data gathering) ===`);

  // Always fetch core market data first — most templates need it.
  const data = await getMarketData();
  const bucketNote = process.env.COINGECKO_API_KEY
    ? "key: Demo plan, 100/min bucket"
    : "key: none, shared 5-15/min bucket";
  console.log(`  CoinGecko markets: ${data.length} coins fetched. (${bucketNote})`);

  // v9.4 FIX: These 5 supplementary sources are independent of each other and
  // of getMarketData() above — nothing here reads another's result. They used
  // to run one at a time, which only ever added latency (5 sequential round
  // trips) for zero behavioral benefit, since each already fails gracefully
  // on its own. Promise.allSettled runs them concurrently instead; a slow or
  // failing source still can't block or fail the others, it just settles
  // later or rejects in its own slot. Logging and fallback behavior for each
  // source are unchanged — if one source is down, the others still work and
  // the script picks the best template from what's available.
  let anomalies = null;
  let trending = null;
  let globalMarket = null;
  let fng = null;
  let broadMovers = null;

  const [anomaliesResult, trendingResult, globalMarketResult, fngResult, broadMoversResult] =
    await Promise.allSettled([
      getBinanceAnomalies(),
      getTrendingCoins(),
      getGlobalMarket(),
      getFearGreed(),
      getBroadMarketMovers(),
    ]);

  if (anomaliesResult.status === "fulfilled") {
    anomalies = anomaliesResult.value;
    if (anomalies.length > 0) {
      console.log(`  Binance ticker: found ${anomalies.length} anomaly/anomalies (|24h| >= ${ANOMALY_THRESHOLD_PCT}%).`);
    } else {
      console.log(`  Binance ticker: nothing unusual (threshold ${ANOMALY_THRESHOLD_PCT}%).`);
    }
  } else {
    console.log(`  Binance ticker: skipped (${anomaliesResult.reason.message}).`);
  }

  if (trendingResult.status === "fulfilled") {
    trending = trendingResult.value;
    console.log(`  CoinGecko trending: ${trending.length} top-100 coin(s).`);
  } else {
    console.log(`  CoinGecko trending: skipped (${trendingResult.reason.message}).`);
  }

  if (globalMarketResult.status === "fulfilled") {
    globalMarket = globalMarketResult.value;
    console.log(`  CoinGecko global: cap ${fmtMcap(globalMarket.totalMcap)}, BTC dom ${globalMarket.btcDominance.toFixed(1)}%.`);
  } else {
    console.log(`  CoinGecko global: skipped (${globalMarketResult.reason.message}).`);
  }

  if (fngResult.status === "fulfilled") {
    fng = fngResult.value;
    console.log(`  Fear & Greed: ${fng.value}/100 (${fng.classification}).`);
  } else {
    console.log(`  Fear & Greed: skipped (${fngResult.reason.message}).`);
  }

  // v9: Broad market movers (top 100 by market cap) — powers the "digest"
  // and "spotlight" styles below. Same graceful-degradation pattern as the
  // other supplementary sources: if this fails, digest/spotlight just won't
  // be selectable that day (buildTemplatePost/buildAiPost both return null
  // on missing ctx.broadMovers, and main() falls back to snapshot).
  if (broadMoversResult.status === "fulfilled") {
    broadMovers = broadMoversResult.value;
    console.log(`  CoinGecko broad movers: ${broadMovers.length} of top 100 fetched.`);
  } else {
    console.log(`  CoinGecko broad movers: skipped (${broadMoversResult.reason.message}).`);
  }

  // ===========================================================================
  // STAGE 2: STRATEGIST — pick the content angle based on what data shows
  // ===========================================================================
  console.log(`\n=== STAGE 2: STRATEGIST (template selection) ===`);

  let style = null;
  const ctx = { globalMarket, fng, anomalies, trending, broadMovers };

  // v9.3 FIX: RUN_MODE=top-movers-digest was set by top-movers-digest.yml
  // but never actually read here. Every prior run fell through to the same
  // anomaly/sentiment/rotation logic as the plain daily pipeline — using
  // the SAME dayIndex as that morning's 08:30 UTC post, so on any day the
  // rotation didn't happen to land on "digest" (8 days out of 9), this
  // workflow posted a near-duplicate of the post already published hours
  // earlier, instead of the top-movers digest its own workflow file
  // describes. This mode now always forces the digest template.
  if (runMode === "top-movers-digest") {
    style = "digest";
    console.log(`  Decision: RUN_MODE=top-movers-digest → forcing "digest" template.`);
  } else if (anomalies && anomalies.length > 0) {
    style = "anomaly";
    console.log(`  Decision: anomaly detected → "anomaly" template.`);
  } else if (fng && (fng.value <= EXTREME_FEAR_THRESHOLD || fng.value >= EXTREME_GREED_THRESHOLD)) {
    style = "sentiment";
    console.log(`  Decision: extreme sentiment (${fng.value}/100) → "sentiment" template.`);
  } else {
    // v5.5: 7-entry rotation (coprime to the 5-vibe rotation) so vibe×template
    // pairings cycle through 35 unique combos over 35 days, not 5 over 5.
    // The 5 base templates appear with strategic repeats (snapshot and
    // trending each appear twice) to reach 7 entries — this is what breaks
    // the lockstep. macro always paired with Plain Update was the most
    // visible symptom of the old bug; now macro cycles through all 5 vibes.
    // v9: Extended to 9 entries to add "digest" and "spotlight" — 9 is still
    // coprime with 5 (gcd(9,5)=1), so the full vibe×template cycle grows to
    // 45 days instead of shrinking back toward lockstep.
    const rotation = ["macro", "trending", "snapshot", "mover", "educational", "snapshot", "trending", "digest", "spotlight"];
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
  // STAGE 4: PUBLISHER — send to Binance Square (with optional chart image)
  // ===========================================================================
  console.log(`\n=== STAGE 4: PUBLISHER (Binance Square) ===`);
  console.log(`  Posting ${text.length} chars as contentType: 1 (text)...`);

  // v9.1: Try to attach a 24h price chart of the featured coins.
  // The infrastructure already exists (buildWeeklyChartConfig, renderChartPng,
  // uploadImageToSquare) — we reuse it for daily posts too. If anything fails
  // (no sparkline data, chart render error, upload error), the post goes out
  // as text-only. The chart is a visual enhancement, not a requirement.
  let imageUrl = null;
  try {
    // For daily posts, we need sparkline data — but getMarketData() only fetches
    // sparklines when sparkline:true is passed (used for Sundays). For weekday
    // posts, we don't have sparklines, so we build a simpler bar chart of 24h
    // percentage changes instead.
    if (data.length > 0 && !isDryRun()) {
      const chartConfig = buildDailyChangeChartConfig(data, dayIndex);
      if (chartConfig) {
        console.log(`  Rendering 24h change chart...`);
        const png = await renderChartPng(chartConfig);
        const tmpFile = path.join(os.tmpdir(), `daily-chart-${Date.now()}.png`);
        fs.writeFileSync(tmpFile, png);
        imageUrl = await uploadImageToSquare(process.env.BINANCE_SQUARE_OPENAPI_KEY, tmpFile);
        fs.unlinkSync(tmpFile);
        console.log(`  Chart uploaded: ${imageUrl ? "yes" : "no"}`);
      }
    }
  } catch (err) {
    console.log(`  Chart generation failed (${err.message}) — posting text-only.`);
    imageUrl = null;
  }

  const id = await postToSquareWithOptionalImage(text, imageUrl);
  if (isDryRun()) {
    console.log(`  [DRY RUN] No post was actually published.`);
    console.log(`  Re-run with dry_run unchecked to publish for real.`);
  } else if (id && id !== "dry-run-id") {
    console.log(`  SUCCESS — posted! View at: https://www.binance.com/square/post/${id}`);
  } else {
    console.log(`  Post likely succeeded, but no ID was returned in the response.`);
  }

  // v9: Optional cross-post of the same text to X, from this same account.
  // Never blocks or fails the run — Square is the primary platform, X is a
  // bonus. Wrapped so a Twitter-side failure never masks the fact that the
  // Square post above already succeeded.
  try {
    const tweetId = await postToTwitter(text);
    if (tweetId) {
      console.log(`  Cross-posted to X: https://x.com/i/web/status/${tweetId}`);
    }
  } catch (e) {
    console.log(`  Twitter cross-post failed (Square post above still succeeded): ${e.message}`);
  }
}

// v7: Guard the auto-run so this file can be `import`-ed by a test suite
// without immediately hitting live network calls and trying to post. Only
// calls main() when post.mjs is the script node was actually invoked with
// (`node post.mjs`) — exactly what daily-post.yml and weekly runs already do,
// so this changes nothing about how the GitHub Actions workflows behave.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Failed:", err.message);
    process.exit(1);
  });
}

// v7: Exported for test/post.test.mjs. These are the pure, no-network
// functions — formatting, template builders, and the validation/safety gate.
// Deliberately NOT exporting the network fetchers (getMarketData etc.) or
// the Square API calls — those need real (or mocked) HTTP and belong in an
// integration-test layer this project doesn't have yet, not a unit suite.
export {
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
  buildTopMoversDigestPost,
  buildMarketSpotlightPost,
  percentEncode,
  buildOAuth1Header,
  buildQuickChartPreviewUrl,
  buildDraftIssueBody,
  parseDraftIssue,
};
