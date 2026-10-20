// test/providers.test.mjs — v10.2
// AI-provider request/response handling and the SEC user-agent rule.
// No network: global fetch is replaced per test.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  groqExtras,
  callOpenAICompatible,
  callGemini,
  fetchNewsFeed,
  GROQ_MODEL,
  GEMINI_MODEL,
  OPENROUTER_MODEL,
} from "../post.mjs";

const realFetch = globalThis.fetch;
let calls;

function mockFetch(responder) {
  calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts, body: opts.body ? JSON.parse(opts.body) : null });
    return responder(String(url), opts);
  };
}
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

beforeEach(() => { calls = []; });
afterEach(() => { globalThis.fetch = realFetch; delete process.env.SEC_USER_AGENT; });

describe("default models (retired ones must not come back)", () => {
  test("Groq default is not the Llama 3.3 model Groq retired on 2026-08-16", () => {
    assert.equal(GROQ_MODEL, "openai/gpt-oss-120b");
    assert.doesNotMatch(GROQ_MODEL, /llama-3\.3-70b-versatile/);
  });
  test("Gemini default is not a 2.0 / 2.5 model (shut down / scheduled to shut down)", () => {
    assert.equal(GEMINI_MODEL, "gemini-3.8-flash");
    assert.doesNotMatch(GEMINI_MODEL, /gemini-2\.[05]/);
  });
  test("OpenRouter default is the free router, not the Llama slug OpenRouter stopped offering for free", () => {
    assert.equal(OPENROUTER_MODEL, "openrouter/free");
    assert.doesNotMatch(OPENROUTER_MODEL, /llama-3\.3-70b-instruct/);
  });
});

describe("groqExtras", () => {
  test("gpt-oss gets low reasoning effort and a bigger token budget", () => {
    assert.deepEqual(groqExtras("openai/gpt-oss-120b"), { reasoning_effort: "low", max_tokens: 2000 });
    assert.deepEqual(groqExtras("openai/gpt-oss-20b"), { reasoning_effort: "low", max_tokens: 2000 });
  });
  test("other models are left exactly as before", () => {
    assert.deepEqual(groqExtras("qwen/qwen3.6-27b"), {});
    assert.deepEqual(groqExtras(undefined), {});
  });
});

describe("callOpenAICompatible", () => {
  const ok = (content, finish = "stop") =>
    json({ choices: [{ finish_reason: finish, message: { content } }] });

  test("without extras the request is unchanged (800 tokens, no reasoning_effort)", async () => {
    mockFetch(() => ok("hello"));
    await callOpenAICompatible("hi", "k", "m", "https://x.test/v1");
    assert.equal(calls[0].body.max_tokens, 800);
    assert.equal("reasoning_effort" in calls[0].body, false);
  });
  test("extras override max_tokens and add reasoning_effort", async () => {
    mockFetch(() => ok("hello"));
    await callOpenAICompatible("hi", "k", "openai/gpt-oss-120b", "https://x.test/v1", 60_000, groqExtras("openai/gpt-oss-120b"));
    assert.equal(calls[0].body.max_tokens, 2000);
    assert.equal(calls[0].body.reasoning_effort, "low");
    assert.equal(calls[0].body.model, "openai/gpt-oss-120b");
  });
  test("reasoning-only reply (empty content) returns null so the next provider is tried", async () => {
    mockFetch(() => json({ choices: [{ finish_reason: "stop", message: { content: "", reasoning: "thinking..." } }] }));
    assert.equal(await callOpenAICompatible("hi", "k", "m", "https://x.test/v1"), null);
  });
  test("finish_reason length is rejected, <think> blocks are stripped", async () => {
    mockFetch(() => ok("partial", "length"));
    await assert.rejects(callOpenAICompatible("hi", "k", "m", "https://x.test/v1"), /finish_reason: length/);
    mockFetch(() => ok("<think>plan</think>Final text"));
    assert.equal(await callOpenAICompatible("hi", "k", "m", "https://x.test/v1"), "Final text");
  });
});

describe("callGemini", () => {
  const reply = (parts, finishReason = "STOP") => json({ candidates: [{ finishReason, content: { parts } }] });

  test("3.x models get a large output budget and no thinkingBudget field", async () => {
    mockFetch(() => reply([{ text: "ok" }]));
    await callGemini("p", "key", "gemini-3.8-flash");
    const cfg = calls[0].body.generationConfig;
    assert.equal(cfg.maxOutputTokens, 4096);
    assert.equal("thinkingConfig" in cfg, false);
    assert.match(calls[0].url, /models\/gemini-3\.8-flash:generateContent/);
  });
  test("2.5 keeps thinking disabled; legacy budget unchanged", async () => {
    mockFetch(() => reply([{ text: "ok" }]));
    await callGemini("p", "key", "gemini-2.5-flash");
    assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.equal(calls[0].body.generationConfig.maxOutputTokens, 800);
  });
  test("joins all visible text parts and skips thought parts", async () => {
    mockFetch(() => reply([{ text: "internal", thought: true }, { text: "Part one. " }, { text: "Part two." }]));
    assert.equal(await callGemini("p", "key", "gemini-3.8-flash"), "Part one. Part two.");
  });
  test("MAX_TOKENS is still rejected", async () => {
    mockFetch(() => reply([{ text: "cut" }], "MAX_TOKENS"));
    await assert.rejects(callGemini("p", "key", "gemini-3.8-flash"), /MAX_TOKENS/);
  });
});

describe("fetchNewsFeed user-agent", () => {
  const rss = '<?xml version="1.0"?><rss><channel><item><title>T</title><link>https://a.test/1</link></item></channel></rss>';
  const run = async (url) => {
    mockFetch(() => new Response(rss, { status: 200 }));
    await fetchNewsFeed({ name: "X", url }, null);
    return calls[0].opts.headers["User-Agent"];
  };

  test("SEC_USER_AGENT is sent to sec.gov only", async () => {
    process.env.SEC_USER_AGENT = "my-bot me@example.com";
    assert.equal(await run("https://www.sec.gov/news/pressreleases.rss"), "my-bot me@example.com");
    assert.match(await run("https://cointelegraph.com/rss"), /^Mozilla\/5\.0/);
  });
  test("a look-alike host does not receive it", async () => {
    process.env.SEC_USER_AGENT = "my-bot me@example.com";
    assert.match(await run("https://notsec.gov.evil.test/feed"), /^Mozilla\/5\.0/);
  });
  test("unset => default user-agent even for sec.gov", async () => {
    assert.match(await run("https://www.sec.gov/news/pressreleases.rss"), /^Mozilla\/5\.0/);
  });
});

describe("news feed fetching: retry + real error reason (v10.2)", () => {
  const rss = '<?xml version="1.0"?><rss><channel><item><title>Bitcoin hits a new high</title><link>https://a.test/1</link><pubDate>Mon, 19 Oct 2026 07:00:00 GMT</pubDate></item></channel></rss>';
  const feed = { name: "X", url: "https://news.example.test/rss" };
  const netErr = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("boom"), { code }) });
  beforeEach(() => { process.env.NEWS_RETRY_DELAY_MS = "0"; });
  afterEach(() => { delete process.env.NEWS_RETRY_DELAY_MS; });

  test("a network failure is retried once and then succeeds", async () => {
    let n = 0;
    mockFetch(() => { if (++n === 1) throw netErr("ECONNRESET"); return new Response(rss, { status: 200 }); });
    const items = await fetchNewsFeed(feed, null);
    assert.equal(calls.length, 2);
    assert.equal(items.length, 1);
  });
  test("two failures: the error names the real cause, not just 'fetch failed'", async () => {
    mockFetch(() => { throw netErr("UND_ERR_CONNECT_TIMEOUT"); });
    await assert.rejects(fetchNewsFeed(feed, null), /fetch failed \[UND_ERR_CONNECT_TIMEOUT\]/);
    assert.equal(calls.length, 2);
  });
  test("an HTTP error status is NOT retried", async () => {
    mockFetch(() => new Response("no", { status: 403 }));
    await assert.rejects(fetchNewsFeed(feed, null), /HTTP 403/);
    assert.equal(calls.length, 1);
  });
  test("a timeout is reported as 'timed out'", async () => {
    mockFetch(() => { throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }); });
    await assert.rejects(fetchNewsFeed(feed, null), /timed out/);
  });
});
