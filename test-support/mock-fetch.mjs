// test-support/mock-fetch.mjs — preload used by test/e2e-news.test.mjs (node --import). Replaces global fetch with fixtures for feeds, Groq, Ollama, Telegram and Square. Behaviour is switched by MOCK_* env vars. Not a test file itself.
import fs from "fs";
const rss = (items) => `<?xml version="1.0"?><rss version="2.0"><channel>${items.map(([t, mins, d]) =>
  `<item><title><![CDATA[${t}]]></title><link>https://ex.test/${encodeURIComponent(t)}</link><pubDate>${new Date(Date.now() - mins * 60000).toUTCString()}</pubDate><description><![CDATA[<p>${d || ""}</p>]]></description></item>`).join("")}</channel></rss>`;
const FEEDS = {
  "coindesk.com": rss([["SEC approves spot Solana ETF from Grayscale", 30, "The regulator cleared the $1.2 billion fund on Sunday."], ["Bitcoin price prediction: where next for BTC", 5, ""]]),
  "decrypt.co": rss([["Grayscale's Solana ETF wins SEC approval", 20, ""], ["Top 10 crypto to buy before the weekend ends", 3, ""]]),
  "cointelegraph.com": rss([["Minor wallet adds a dark mode feature option", 15, "Cosmetic update."]]),
  "theblock.co": rss([["Ancient headline about something that happened yesterday", 600, "old"]]),
};
const E = process.env;
if (E.MOCK_STORY === "hack-single") {
  FEEDS["coindesk.com"] = rss([["Major exchange hacked, $50 million stolen from hot wallet", 10, "Attackers drained the wallet."]]);
  FEEDS["decrypt.co"] = rss([]);
} else if (E.MOCK_STORY === "hack-double") {
  FEEDS["coindesk.com"] = rss([["Major exchange hacked, $50 million stolen from hot wallet", 10, "Attackers drained the wallet."]]);
  FEEDS["decrypt.co"] = rss([["Exchange hot wallet hack: $50 million stolen", 6, ""]]);
}
const log = (m) => { if (E.MOCK_LOG) fs.appendFileSync(E.MOCK_LOG, m + "\n"); };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const GOOD = E.MOCK_STORY?.startsWith("hack") ? "HEADLINE: Major exchange hacked, $50 million stolen from hot wallet\nCONTEXT: Attackers drained the wallet." : "HEADLINE: SEC clears Grayscale's spot Solana ETF, a $1.2 billion fund\nCONTEXT: The regulator cleared the fund on Sunday.";
let tgId = null, tgSent = false, tgUpdate = 100;
// ---- v10.2 additions: Binance market data, QuickChart, image upload, CoinGecko ----
const COINS_MOCK = { bitcoin: "BTC", ethereum: "ETH", binancecoin: "BNB", solana: "SOL", ripple: "XRP", cardano: "ADA", dogecoin: "DOGE", chainlink: "LINK" };
const PRICES = { BTC: 82950, ETH: 3500, BNB: 640, SOL: 180, XRP: 2.4, ADA: 0.7, DOGE: 0.25, LINK: 18 };
const btcPrice = () => Number(E.MOCK_BTC || PRICES.BTC);
const btcStart = () => Number(E.MOCK_BTC_START || 83420);
const btcChg = () => Number(E.MOCK_BTC_CHG || -1.2);
const priceOf = (sym) => (sym === "BTC" ? btcPrice() : PRICES[sym]);
const startOf = (sym) => (sym === "BTC" ? btcStart() : PRICES[sym]);
const chgOf = (sym) => (sym === "BTC" ? btcChg() : 0.5);
function binanceMock(u) {
  const url = new URL(u);
  if (url.pathname.endsWith("/ticker/24hr")) {
    const wanted = url.searchParams.get("symbols");
    const pairs = wanted ? JSON.parse(wanted) : Object.keys(PRICES).map((s) => s + "USDT");
    if (E.MOCK_BINANCE === "fail") return new Response("down", { status: 503 });
    return json(pairs.map((p) => { const s = p.slice(0, -4); const pr = priceOf(s); return { symbol: p, lastPrice: String(pr), priceChangePercent: String(chgOf(s)), highPrice: String(pr * 1.01), lowPrice: String(pr * 0.99), quoteVolume: "1000000000" }; }));
  }
  if (url.pathname.endsWith("/klines")) {
    if (E.MOCK_KLINES === "fail") return new Response("nope", { status: 500 });
    const s = url.searchParams.get("symbol").slice(0, -4);
    const n = Number(url.searchParams.get("limit"));
    const first = url.searchParams.get("interval") === "5m" ? startOf(s) : priceOf(s) * 0.97;
    return json(Array.from({ length: n }, (_, i) => { const c = first + ((priceOf(s) - first) * i) / Math.max(1, n - 1); return [Date.now() - (n - i) * 60000, String(i === 0 ? first : c), String(c), String(c), String(c)]; }));
  }
  return new Response("not mocked: " + u, { status: 404 });
}
function coingeckoMock(u) {
  const url = new URL(u);
  if (url.pathname.endsWith("/coins/markets")) {
    const ids = (url.searchParams.get("ids") || "").split(",").filter(Boolean);
    return json(ids.map((id) => { const s = COINS_MOCK[id]; const pr = priceOf(s); return { id, symbol: s.toLowerCase(), current_price: pr, price_change_percentage_24h_in_currency: chgOf(s), price_change_percentage_7d_in_currency: 3.4, sparkline_in_7d: { price: Array.from({ length: 30 }, (_, i) => pr * (0.97 + i * 0.001)) }, total_volume: 1e9, market_cap: 1e11, market_cap_rank: 1, high_24h: pr * 1.01, low_24h: pr * 0.99 }; }));
  }
  if (url.pathname.endsWith("/global")) return json({ data: { total_market_cap: { usd: 2.74e12 }, total_volume: { usd: 1.1e11 }, market_cap_percentage: { btc: 60.1, eth: 12.3 }, market_cap_change_percentage_24h_usd: -0.5 } });
  if (url.pathname.endsWith("/search/trending")) return json({ coins: [{ item: { symbol: "PRL", name: "Pearl", market_cap_rank: 97 } }] });
  return new Response("not mocked: " + u, { status: 404 });
}
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("binance.vision")) return binanceMock(u);
  if (u.includes("api.coingecko.com")) return coingeckoMock(u);
  if (u.includes("alternative.me")) return json({ data: [{ value: "59", value_classification: "Greed" }] });
  if (u.includes("quickchart.io")) { log("quickchart"); return new Response(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), { status: 200 }); }
  if (u.includes("en.wikipedia.org/api/rest_v1/page/summary/")) { const title = decodeURIComponent(u.split("/summary/")[1] || "Topic"); return json({ title, extract: title === "Stablecoin" ? "A stablecoin is a type of cryptocurrency designed to keep a steady value relative to a reference asset such as the US dollar." : `${title} is a topic in crypto.` }); }
  if (u.includes("/image/presignedUrl")) { log("IMAGE-UPLOAD"); return json({ code: "000000", data: { presignedUrl: "https://s3.example.test/put", fileTicket: "t1" } }); }
  if (u.includes("s3.example.test")) return new Response("", { status: 200 });
  if (u.includes("/image/imageStatus")) return json({ code: "000000", data: { status: 1, imageUrl: "https://img.example.test/chart.png" } });
  const host = Object.keys(FEEDS).find((h) => u.includes(h));
  if (host) {
    if (E.MOCK_FEEDS === "fail") return new Response("blocked", { status: 403 });
    const h = new Headers(opts.headers || {});
    if (E.MOCK_ETAG && h.get("if-none-match") === "v1") { log(`304 ${host}`); return new Response(null, { status: 304 }); }
    return new Response(FEEDS[host], { status: 200, headers: E.MOCK_ETAG ? { etag: "v1" } : {} });
  }
  if (u.includes("11434")) {
    if (u.endsWith("/api/tags")) return json({ models: [{ name: "qwen2.5:3b" }] });
    if (E.MOCK_OLLAMA === "down") throw new Error("connect ECONNREFUSED 127.0.0.1:11434");
    log("ollama call");
    return json({ choices: [{ finish_reason: "stop", message: { content: "<think>hmm</think>" + GOOD } }] });
  }
  if (u.includes("api.groq.com")) {
    log("groq call");
    if (E.MOCK_AI_TEXT) return json({ choices: [{ finish_reason: "stop", message: { content: E.MOCK_AI_TEXT.replace(/\\n/g, "\n") } }] });
    if (E.MOCK_AI === "bad") return json({ choices: [{ finish_reason: "stop", message: { content: "HEADLINE: SEC clears Grayscale Solana ETF worth $9 billion\nCONTEXT: NONE" } }] });
    return json({ choices: [{ finish_reason: "stop", message: { content: GOOD } }] });
  }
  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop();
    if (method === "sendPhoto") { const f = opts.body; const photo = f && f.get ? f.get("photo") : null; log("telegram photo " + (photo ? photo.size : 0)); return json({ ok: true, result: { message_id: 7 } }); }
    const body = JSON.parse(opts.body || "{}");
    const ok = (result) => json({ ok: true, result });
    if (method === "sendMessage" && !body.reply_markup) { log("telegram text " + body.text.length); return ok({ message_id: 8 }); }
    if (method === "sendMessage") { { const cd = body.reply_markup.inline_keyboard[0][0].callback_data; tgId = cd.slice(cd.indexOf(":") + 1); } tgSent = true; log("telegram sent"); return ok({ message_id: 9 }); }
    if (method === "getUpdates") {
      if (body.timeout === 0 || !tgSent) return ok([]);
      if (E.MOCK_TG === "approve" || E.MOCK_TG === "reject") {
        const prefix = E.MOCK_TG === "approve" ? "ok" : "no";
        return ok([{ update_id: ++tgUpdate, callback_query: { id: "cb", data: `${prefix}:${tgId}`, from: { id: Number(E.TELEGRAM_CHAT_ID) }, message: { chat: { id: Number(E.TELEGRAM_CHAT_ID) } } } }]);
      }
      await new Promise((r) => setTimeout(r, 700));
      return ok([]);
    }
    return ok(true);
  }
  if (u.includes("/content/add")) {
    if (E.MOCK_SQUARE === "fail") return json({ code: "100001", message: "boom" }, 500);
    if (E.MOCK_SQUARE === "limit") return json({ code: "220009", message: "Daily post limit exceeded for OpenAPI" });
    const body = JSON.parse(opts.body);
    log("SQUARE " + JSON.stringify(body.bodyTextOnly || body));
    if (body.imageList) log("IMAGELIST " + JSON.stringify(body.imageList));
    if (body.coverImageList) log("COVERLIST " + JSON.stringify(body.coverImageList));
    console.log("[MOCK SQUARE] published:", JSON.stringify(body));
    return json({ code: "000000", data: { id: "mock-" + process.pid } });
  }
  return new Response("not mocked: " + u, { status: 404 });
};
