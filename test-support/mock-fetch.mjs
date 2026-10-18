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
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
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
    if (E.MOCK_AI === "bad") return json({ choices: [{ finish_reason: "stop", message: { content: "HEADLINE: SEC clears Grayscale Solana ETF worth $9 billion\nCONTEXT: NONE" } }] });
    return json({ choices: [{ finish_reason: "stop", message: { content: GOOD } }] });
  }
  if (u.includes("api.telegram.org")) {
    const method = u.split("/").pop();
    const body = JSON.parse(opts.body || "{}");
    const ok = (result) => json({ ok: true, result });
    if (method === "sendMessage") { tgId = body.reply_markup.inline_keyboard[0][0].callback_data.split(":")[1]; tgSent = true; log("telegram sent"); return ok({ message_id: 9 }); }
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
    const body = JSON.parse(opts.body);
    log("SQUARE " + JSON.stringify(body.bodyTextOnly || body));
    console.log("[MOCK SQUARE] published:", JSON.stringify(body));
    return json({ code: "000000", data: { id: "mock-" + process.pid } });
  }
  return new Response("not mocked: " + u, { status: 404 });
};
