// test/telegram.test.mjs — approval flow against a fake Telegram server.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { telegramConfigured, escapeHtml, storyId, buildApprovalMessage, requestApproval } from "../telegram.mjs";
import { clusterStories } from "../news.mjs";

const story = clusterStories([
  { title: "SEC approves spot Solana ETF <now>", link: "https://ex.test/a?x=1&y=2", source: "CoinDesk", summary: "", publishedAt: Date.now() },
])[0];

// A fake Telegram: records calls, serves queued updates to getUpdates.
function fakeTelegram({ queue = [], sendFails = false, pollFailsOnce = false } = {}) {
  const calls = [];
  let pollFailed = false;
  const fetchFn = async (url, opts) => {
    const method = url.split("/").pop();
    const body = JSON.parse(opts.body);
    calls.push({ method, body });
    const ok = (result) => new Response(JSON.stringify({ ok: true, result }), { status: 200 });
    if (method === "sendMessage") {
      return sendFails ? new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 }) : ok({ message_id: 77 });
    }
    if (method === "getUpdates") {
      if (pollFailsOnce && body.timeout > 0 && !pollFailed) { pollFailed = true; throw new Error("network down"); }
      // timeout 0 = the drain call: hand back (and consume) only the stale taps
      if (body.timeout === 0) {
        const stale = queue.filter((u) => u.__stale);
        for (const u of stale) queue.splice(queue.indexOf(u), 1);
        return ok(stale);
      }
      const live = queue.filter((u) => !u.__stale && u.update_id >= (body.offset || 0));
      for (const u of live) queue.splice(queue.indexOf(u), 1);
      return ok(live);
    }
    return ok(true);
  };
  return { fetchFn, calls };
}
const tap = (update_id, data, { chat = 111, from = 111 } = {}) => ({
  update_id, callback_query: { id: `cb${update_id}`, data, from: { id: from }, message: { chat: { id: chat } } },
});
const base = (extra) => ({ token: "T", chatId: "111", message: "m", id: "abc", waitMs: 300, pollGapMs: 5, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))), ...extra });

describe("helpers", () => {
  test("telegramConfigured needs both values, non-blank", () => {
    assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: "a", TELEGRAM_CHAT_ID: "1" }), true);
    assert.equal(telegramConfigured({ TELEGRAM_BOT_TOKEN: "a", TELEGRAM_CHAT_ID: "  " }), false);
    assert.equal(telegramConfigured({}), false);
  });
  test("escapeHtml and a stable short story id", () => {
    assert.equal(escapeHtml("<a & b>"), "&lt;a &amp; b&gt;");
    assert.equal(storyId(story), storyId(story));
    assert.match(storyId(story), /^[0-9a-f]{10}$/);
  });
  test("approval message escapes the draft, shows score and links, stays under Telegram's limit", () => {
    const m = buildApprovalMessage({ text: "H <b>x</b> & y", story, score: 80, reasons: ["+45 impact"], provider: "groq", decisionReason: "sensitive story" });
    assert.match(m, /&lt;b&gt;x&lt;\/b&gt; &amp; y/);
    assert.match(m, /Score 80/);
    assert.match(m, /href="https:\/\/ex\.test\/a\?x=1&amp;y=2"/);
    assert.doesNotMatch(m, /<b>x<\/b>/);
    const huge = buildApprovalMessage({ text: "z".repeat(9000), story, score: 1 });
    assert.ok(huge.length <= 3800);
  });
});

describe("requestApproval", () => {
  test("approve", async () => {
    const t = fakeTelegram({ queue: [tap(5, "ok:abc")] });
    assert.equal(await requestApproval(base({ fetchFn: t.fetchFn })), "approved");
    const send = t.calls.find((c) => c.method === "sendMessage");
    assert.equal(send.body.reply_markup.inline_keyboard[0].length, 2);
    assert.ok(t.calls.some((c) => c.method === "answerCallbackQuery"));
    assert.ok(t.calls.some((c) => c.method === "editMessageReplyMarkup"));
  });

  test("reject", async () => {
    assert.equal(await requestApproval(base({ fetchFn: fakeTelegram({ queue: [tap(5, "no:abc")] }).fetchFn })), "rejected");
  });

  test("no tap before the deadline = timeout (never approved)", async () => {
    const t = fakeTelegram();
    assert.equal(await requestApproval(base({ fetchFn: t.fetchFn, waitMs: 60 })), "timeout");
    assert.ok(t.calls.some((c) => c.method === "editMessageReplyMarkup" && /Expired/.test(JSON.stringify(c.body))));
  });

  test("a tap from another chat is ignored, even with the right button data", async () => {
    const t = fakeTelegram({ queue: [tap(5, "ok:abc", { chat: 999, from: 999 })] });
    assert.equal(await requestApproval(base({ fetchFn: t.fetchFn, waitMs: 60 })), "timeout");
    assert.ok(t.calls.some((c) => c.method === "answerCallbackQuery" && /Not authorised/.test(JSON.stringify(c.body))));
  });

  test("a tap meant for a different/old draft cannot approve this one", async () => {
    const t = fakeTelegram({ queue: [tap(5, "ok:OLDID")] });
    assert.equal(await requestApproval(base({ fetchFn: t.fetchFn, waitMs: 60 })), "timeout");
  });

  test("taps queued BEFORE this draft was sent are drained and ignored", async () => {
    const t = fakeTelegram({ queue: [{ ...tap(3, "ok:abc"), __stale: true }] });
    assert.equal(await requestApproval(base({ fetchFn: t.fetchFn, waitMs: 60 })), "timeout");
  });

  test("in a private chat the tapper must be the owner", async () => {
    const t = fakeTelegram({ queue: [tap(5, "ok:abc", { chat: 111, from: 222 })] });
    assert.equal(await requestApproval(base({ fetchFn: t.fetchFn, waitMs: 60 })), "timeout");
  });

  test("send failure returns error, so the caller does not post", async () => {
    assert.equal(await requestApproval(base({ fetchFn: fakeTelegram({ sendFails: true }).fetchFn })), "error");
  });

  test("a network blip while waiting is retried, then the tap still works", async () => {
    const t = fakeTelegram({ queue: [tap(5, "ok:abc")], pollFailsOnce: true });
    assert.equal(await requestApproval(base({ fetchFn: t.fetchFn, waitMs: 500 })), "approved");
  });
});
