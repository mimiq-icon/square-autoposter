// post.mjs
// Fetches live crypto data (free CoinGecko API, no key needed) and posts to
// Binance Square with $cashtags. Rotates across 4 content styles through the
// week so it isn't the same post shape every day.
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

// Binance rejected a post with 5 cashtags (error 220095: "Coin pair count
// exceeds the allowed limit"). Keep every post at or under this number.
const MAX_CASHTAGS_PER_POST = 3;

const SQUARE_ENDPOINT =
  "https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add";

async function getMarketData() {
  const ids = COINS.map((c) => c.id).join(",");
  const url = `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&ids=${ids}&price_change_percentage=24h,7d`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CoinGecko error: ${res.status}`);
  const rows = await res.json();

  // Turn the array into a lookup keyed by CoinGecko id, matched to our symbols
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

// Rotate which subset of the watchlist gets featured, so the same coins
// aren't always front and center and we always stay within the cashtag cap.
function rotateSubset(list, size, offset) {
  const out = [];
  for (let i = 0; i < size && i < list.length; i++) {
    out.push(list[(offset + i) % list.length]);
  }
  return out;
}

// --- Template 1: market snapshot (rotating subset of coins) ---
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

// --- Template 2: today's biggest mover (always exactly 1 cashtag) ---
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

// --- Template 3: short educational tip, tied to one rotating coin ---
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

// --- Template 4: weekly recap (only runs on Sundays) ---
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
  const dayIndex = now.getDate(); // used to rotate subsets/tips deterministically
  const isSunday = now.getDay() === 0;

  let text;
  if (isSunday) {
    text = buildWeeklyRecapPost(data, dayIndex);
  } else {
    // Rotate daily between snapshot / top mover / educational
    const rotation = [buildSnapshotPost, buildTopMoverPost, buildEducationalPost];
    const fn = rotation[dayIndex % rotation.length];
    text = fn(data, dayIndex);
  }

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
