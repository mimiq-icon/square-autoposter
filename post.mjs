// post.mjs
// Fetches live crypto data (free CoinGecko API, no key needed) and posts to
// Binance Square with $cashtags.
//
// Content generation has two modes:
//   1. AI mode (optional): if GEMINI_API_KEY is set, a free-tier Gemini model
//      writes the post text from the real price data.
//   2. Template mode (default / fallback): fixed templates, no external AI call.
// AI output is always validated before use (cashtag count, banned phrases).
// If it fails validation, errors, or no key is set, we silently fall back to
// templates — the bot never goes a day without posting just because the AI
// step had a bad day.
//
// Requires: Node.js 18+ (built-in fetch). No npm install needed.
// Required env var: BINANCE_SQUARE_OPENAPI_KEY
// Optional env var: GEMINI_API_KEY (get one free, no card, at aistudio.google.com/apikey)

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

const SQUARE_ENDPOINT =
  "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

// Free-tier-eligible model as of 2026. Override with GEMINI_MODEL if Google
// changes free-tier eligibility later.
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

// Phrases that turn a factual update into an implicit trading suggestion.
// This matters more here than in typical content: the "Write to Earn" model
// pays a commission specifically when readers trade off a cashtag, so any
// nudge toward buying/selling is a conflict of interest, not just a style
// choice. Kept intentionally broad/blunt — better to over-reject into the
// safe template fallback than let a nudge through.
const BANNED_PHRASES = [
  "buy the dip", "buying opportunity", "who's buying", "who is buying",
  "good entry", "entry point", "target price", "price target",
  "about to explode", "guaranteed", "guarantee", "sure thing",
  "breakout incoming", "short squeeze", "load up", "your play",
  "financial advice to buy", "should you buy", "should you sell",
  "sell now", "buy now", "moon", "to the moon", "100x", "get in now",
];

async function getMarketData() {
  const ids = COINS.map((c) => c.id).join(",");
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h,7d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
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
    };
  }).filter(Boolean);
}

function fmtPct(n) {
  if (n === null || n === undefined) return "n/a";
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtPrice(n) {
  return `$${n.toLocaleString(undefined, { maximumFractionDigits: n < 10 ? 4 : 2 })}`;
}

function rotateSubset(list, size, offset) {
  const out = [];
  for (let i = 0; i < size && i < list.length; i++) {
    out.push(list[(offset + i) % list.length]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Template mode (default + fallback) — unchanged from the original script.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// AI mode (optional) — only runs if GEMINI_API_KEY is set.
// ---------------------------------------------------------------------------

function countCashtags(text) {
  const matches = text.match(/\$[A-Z]{2,6}\b/g) || [];
  return matches;
}

// Reject anything that isn't grounded in the actual watchlist, has too many
// cashtags, or contains a banned phrase. This runs on every AI response
// before it's allowed anywhere near the post endpoint.
function isSafeAiText(text, allowedSymbols) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim();
  if (trimmed.length < 10 || trimmed.length > 700) return false;

  const tags = countCashtags(trimmed);
  if (tags.length > MAX_CASHTAGS_PER_POST) return false;
  for (const tag of tags) {
    if (!allowedSymbols.includes(tag.slice(1))) return false;
  }

  const lower = trimmed.toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase)) return false;
  }

  return true;
}

async function callGemini(prompt) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 220, temperature: 0.8 },
    }),
  });

  if (!res.ok) {
    console.log(`Gemini API non-OK response: ${res.status}`);
    return null;
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return text || null;
}

// style is one of "snapshot" | "mover" | "educational" — used only to steer
// the prompt, same as the dayIndex rotation already did for templates.
async function buildAiPost(data, dayIndex, style) {
  const featured = rotateSubset(data, MAX_CASHTAGS_PER_POST, dayIndex);
  const priceLines = featured
    .map((d) => `${d.symbol}: ${fmtPrice(d.price)}, 24h change ${fmtPct(d.change24h)}`)
    .join("; ");
  const allowedSymbols = featured.map((d) => d.symbol);

  const styleInstruction = {
    snapshot: "Write a short, neutral market-snapshot update covering these coins.",
    mover: "Write a short update focused on whichever of these coins moved the most in the last 24h.",
    educational: "Write a short update that gives one genuine, factual crypto/market-structure concept (e.g. market cap vs FDV, funding rates, volume), then mentions the current price of one of these coins as an aside.",
  }[style];

  const prompt = [
    "You are writing a short social media post (2-4 sentences, no more than 700 characters) for a factual crypto market account.",
    styleInstruction,
    `Real, current data (use only this, do not invent numbers): ${priceLines}.`,
    `Use $TICKER cashtags only for these symbols, and no more than ${MAX_CASHTAGS_PER_POST} total: ${allowedSymbols.map((s) => "$" + s).join(", ")}.`,
    "Strict rules: no trading suggestions of any kind (no 'buy', 'sell', 'buying opportunity', 'entry point'); no price predictions or targets; no hype words like 'moon' or 'guaranteed'; no urgency language. Plain, factual, slightly conversational tone is fine. A genuine question to readers about what they're watching is fine, as long as it's not phrased as a trade prompt.",
    "End the post with: Not financial advice. DYOR.",
    "Output only the post text, nothing else — no preamble, no quotes, no markdown.",
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

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

async function postToSquare(text) {
  const key = process.env.BINANCE_SQUARE_OPENAPI_KEY;
  if (!key) {
    throw new Error("Missing BINANCE_SQUARE_OPENAPI_KEY environment variable.");
  }

  const res = await fetch(SQUARE_ENDPOINT, {
    method: "POST",
    headers: {
      "X-Square-OpenAPI-Key": key,
      "Content-Type": "application/json",
      clienttype: "binanceSkill",
    },
    body: JSON.stringify({ bodyTextOnly: text }),
  });

  const data = await res.json();
  if (data.code !== "000000") {
    throw new Error(`Binance Square API error: ${data.code} ${data.message || ""}`);
  }
  return data.data?.id;
}

async function main() {
  const data = await getMarketData();
  const now = new Date();
  const dayIndex = now.getDate();
  const isSunday = now.getDay() === 0;
  const aiEnabled = Boolean(process.env.GEMINI_API_KEY);

  let text = null;
  let source = "template";

  if (isSunday) {
    // Weekly recap stays template-based: it's a fixed 7-day data readout,
    // not a place where varied phrasing adds much.
    text = buildWeeklyRecapPost(data, dayIndex);
  } else {
    const rotation = ["snapshot", "mover", "educational"];
    const style = rotation[dayIndex % rotation.length];

    if (aiEnabled) {
      text = await buildAiPost(data, dayIndex, style);
      if (text) source = "ai";
    }

    if (!text) {
      // Either AI is disabled, or it failed/was rejected — use the
      // corresponding safe template instead.
      const templateFn = { snapshot: buildSnapshotPost, mover: buildTopMoverPost, educational: buildEducationalPost }[style];
      text = style === "mover" ? templateFn(data) : templateFn(data, dayIndex);
      source = "template";
    }
  }

  if (!text) throw new Error("Could not build post text \u2014 check CoinGecko response.");

  console.log(`--- Post preview (source: ${source}) ---`);
  console.log(text);
  console.log("--------------------");

  const id = await postToSquare(text);
  if (id) {
    console.log(`Posted! View it at: https://www.binance.com/square/post/${id}`);
  } else {
    console.log("Post likely succeeded, but no ID was returned in the response.");
  }
}

main().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
