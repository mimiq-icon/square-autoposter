// post.mjs
// Fetches live prices from CoinGecko (free, no API key needed) and posts
// a short market update to Binance Square with $cashtags.
//
// Requires: Node.js 18+ (uses built-in fetch). No npm install needed.
// Requires env var: BINANCE_SQUARE_OPENAPI_KEY (set as a GitHub Actions secret)

const COINS = [
  { id: "bitcoin", symbol: "BTC" },
  { id: "ethereum", symbol: "ETH" },
  { id: "binancecoin", symbol: "BNB" },
  { id: "solana", symbol: "SOL" },
  { id: "ripple", symbol: "XRP" },
];

// Edit the list above to track different coins.
// "id" must match CoinGecko's id (check https://api.coingecko.com/api/v3/coins/list)
// "symbol" is what gets turned into a clickable $cashtag on Binance Square.

const SQUARE_ENDPOINT =
  "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

async function getPrices() {
  const ids = COINS.map((c) => c.id).join(",");
  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
  return res.json();
}

function fmtChange(change) {
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}%`;
}

// Template 1: full snapshot of all tracked coins
function buildSnapshotPost(prices) {
  const lines = COINS.map((c) => {
    const d = prices[c.id];
    if (!d) return null;
    return `$${c.symbol}: $${d.usd.toLocaleString()} (${fmtChange(d.usd_24h_change)} 24h)`;
  }).filter(Boolean);

  if (lines.length === 0) return null;

  return [
    "\uD83D\uDCCA Crypto Market Snapshot",
    ...lines,
    "",
    "Which one are you watching today? Not financial advice \u2014 always DYOR.",
  ].join("\n");
}

// Template 2: highlight whichever tracked coin moved the most in 24h
function buildTopMoverPost(prices) {
  let best = null;
  for (const c of COINS) {
    const d = prices[c.id];
    if (!d) continue;
    if (!best || Math.abs(d.usd_24h_change) > Math.abs(best.change)) {
      best = { symbol: c.symbol, price: d.usd, change: d.usd_24h_change };
    }
  }
  if (!best) return null;

  const direction = best.change >= 0 ? "up" : "down";
  return [
    `\uD83D\uDC40 Today's biggest mover: $${best.symbol}`,
    `Price: $${best.price.toLocaleString()} \u2014 ${direction} ${Math.abs(best.change).toFixed(2)}% in 24h.`,
    "",
    "Market data only, not a trade signal. Always DYOR.",
  ].join("\n");
}

const TEMPLATES = [buildSnapshotPost, buildTopMoverPost];

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
  const prices = await getPrices();

  // Rotate templates by day of month so content isn't identical every day
  const dayIndex = new Date().getDate() % TEMPLATES.length;
  const text = TEMPLATES[dayIndex](prices);
  if (!text) throw new Error("Could not build post text \u2014 check CoinGecko response.");

  console.log("--- Post preview ---");
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
      
