// telegram.mjs  (v10.1)
// ============================================================================
// One-tap human approval over Telegram. The bot sends you the exact post with
// two buttons, [Post] and [Skip], and waits. Nothing is published until you
// tap Post. No tap before the deadline = the story is dropped, never posted.
//
// Security: only taps that come from TELEGRAM_CHAT_ID are honoured. Anyone who
// finds the bot and messages it cannot approve anything. Buttons are bound to
// one story id, so tapping an old draft's button can't approve a new one.
//
// Setup (2 minutes, on your phone): message @BotFather -> /newbot -> copy the
// token. Send your new bot any message, then open
//   https://api.telegram.org/bot<TOKEN>/getUpdates
// and copy "chat":{"id": ...} — that number is TELEGRAM_CHAT_ID.
//
// `fetchFn`, `sleep` and `now` are injectable so the whole flow is tested
// against a fake Telegram server (test/telegram.test.mjs).
// ============================================================================
import crypto from "crypto";

export function telegramConfigured(env = process.env) {
  return Boolean(String(env.TELEGRAM_BOT_TOKEN || "").trim() && String(env.TELEGRAM_CHAT_ID || "").trim());
}

export function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function storyId(story) {
  const key = story.primary.link || story.primary.title;
  return crypto.createHash("sha1").update(key).digest("hex").slice(0, 10);
}

export function buildApprovalMessage({ text, story, score, reasons = [], provider, decisionReason }) {
  const links = story.items
    .filter((i) => /^https?:\/\//i.test(i.link || ""))
    .slice(0, 3)
    .map((i) => `<a href="${escapeHtml(i.link).replace(/"/g, "&quot;")}">${escapeHtml(i.source)}</a>`);
  const lines = [
    "<b>Approve this post?</b>",
    decisionReason ? `<i>${escapeHtml(decisionReason)}</i>` : "",
    "",
    `<pre>${escapeHtml(text)}</pre>`,
    "",
    `Score ${score} · ${escapeHtml(reasons.slice(0, 4).join("; "))}`,
    `Written by: ${provider ? escapeHtml(provider) : "template (original headline)"}`,
    links.length ? `Read: ${links.join(" · ")}` : "",
  ].filter((l, i, a) => l !== "" || (a[i - 1] !== "" && i !== 0));
  let msg = lines.join("\n");
  if (msg.length > 3800) msg = msg.slice(0, 3790) + "…";
  return msg;
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns "approved" | "rejected" | "timeout" | "error".
export async function requestApproval({
  token, chatId, message, id, waitMs,
  fetchFn = fetch, sleep = defaultSleep, now = Date.now, pollGapMs = 0, log = () => {},
}) {
  const chat = String(chatId);
  const api = async (method, body, timeoutMs = 20000) => {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(`Telegram ${method}: ${json.description || res.status}`);
    return json.result;
  };
  const best = async (method, body) => { try { await api(method, body); } catch { /* cosmetic */ } };

  let offset = 0;
  let messageId;
  try {
    // Drain taps left over from earlier drafts so they can't be mistaken for this one.
    const old = await api("getUpdates", { timeout: 0, allowed_updates: ["callback_query"] });
    for (const u of old || []) offset = Math.max(offset, u.update_id + 1);

    const sent = await api("sendMessage", {
      chat_id: chat,
      text: message,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: [[
        { text: "✅ Post", callback_data: `ok:${id}` },
        { text: "❌ Skip", callback_data: `no:${id}` },
      ]] },
    });
    messageId = sent.message_id;
  } catch (e) {
    log(`Telegram send failed: ${e.message}`);
    return "error";
  }

  const finish = (label) =>
    best("editMessageReplyMarkup", {
      chat_id: chat, message_id: messageId,
      reply_markup: { inline_keyboard: [[{ text: label, callback_data: "done" }]] },
    });

  const deadline = now() + waitMs;
  while (now() < deadline) {
    const remainingSec = Math.max(1, Math.floor((deadline - now()) / 1000));
    const pollSec = Math.min(25, remainingSec);
    let updates;
    try {
      updates = await api("getUpdates", { offset, timeout: pollSec, allowed_updates: ["callback_query"] }, (pollSec + 10) * 1000);
    } catch (e) {
      log(`Telegram poll failed (${e.message}); retrying`);
      await sleep(2000);
      continue;
    }
    for (const u of updates || []) {
      offset = Math.max(offset, u.update_id + 1);
      const cb = u.callback_query;
      if (!cb) continue;
      const fromChat = String(cb.message?.chat?.id ?? "");
      const isGroup = chat.startsWith("-");
      const authorised = fromChat === chat && (isGroup || String(cb.from?.id) === chat);
      if (!authorised) {
        await best("answerCallbackQuery", { callback_query_id: cb.id, text: "Not authorised." });
        continue;
      }
      if (cb.data === `ok:${id}` || cb.data === `no:${id}`) {
        const approved = cb.data === `ok:${id}`;
        await best("answerCallbackQuery", { callback_query_id: cb.id, text: approved ? "Posting…" : "Skipped." });
        await finish(approved ? "✅ Approved" : "❌ Skipped");
        return approved ? "approved" : "rejected";
      }
      await best("answerCallbackQuery", { callback_query_id: cb.id, text: "That draft has expired." });
    }
    if (pollGapMs) await sleep(pollGapMs);
  }
  await finish("⏱ Expired — not posted");
  return "timeout";
}

// ---------------------------------------------------------------------------
// v10.2: price alerts and the weekly article
// ---------------------------------------------------------------------------

export function buildAlertApprovalMessage({ text, alert, provider }) {
  const lines = [
    "<b>Approve this price alert?</b>",
    "",
    `<pre>${escapeHtml(text)}</pre>`,
    "",
    `${escapeHtml(alert.name)} · ${alert.kind === "level" ? "level cross" : "24h move"} · score ${alert.score}`,
    `Written by: ${provider ? escapeHtml(provider) : "template (data only)"}`,
  ];
  return lines.join("\n");
}

export function buildArticleApprovalMessage({ title, words, provider }) {
  return [
    "<b>Approve this weekly article?</b>",
    "",
    `<b>${escapeHtml(title)}</b>`,
    `${words} words · written by ${provider ? escapeHtml(provider) : "the data template"}`,
    "",
    "The full text is in the messages above. Tap Post to publish it on Binance Square, or Skip.",
  ].join("\n");
}

// Splits long text on paragraph (then line, then space) boundaries so each
// piece fits Telegram's 4096-character message limit.
export function splitForTelegram(text, max = 3500) {
  const out = [];
  let rest = String(text ?? "").trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.3) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

// Sends plain-text messages (no formatting, so markdown in an article shows
// exactly as written). Returns the number sent; throws on the first failure.
export async function sendTextChunks({ token, chatId, text, fetchFn = fetch, max = 3500 }) {
  const parts = splitForTelegram(text, max);
  for (const part of parts) {
    const res = await fetchFn(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: String(chatId), text: part, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.ok === false) throw new Error(`Telegram sendMessage: ${json.description || res.status}`);
  }
  return parts.length;
}
