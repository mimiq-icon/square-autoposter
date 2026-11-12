import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  FetchFailure, explainFetchError, fetchJsonDetailed, needFamily, minSourcesFor, gatherFacts,
  buildResearchArticleMarkdown, RESEARCH_TOPICS,
} from "../research.mjs";

const noSleep = async () => {};
const ok = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers });
const seq = (...steps) => { let i = 0; const calls = []; const f = async (url) => { calls.push(String(url)); const s = steps[Math.min(i++, steps.length - 1)]; if (s instanceof Error) throw s; return typeof s === "function" ? s() : s; }; f.calls = calls; return f; };
const netErr = (code, msg = "fetch failed") => Object.assign(new TypeError(msg), { cause: Object.assign(new Error(code), { code }) });

describe("explainFetchError: 'fetch failed' becomes a reason a person can act on", () => {
  const cases = [
    [Object.assign(new Error("x"), { name: "TimeoutError" }), /timed out/],
    [netErr("UND_ERR_CONNECT_TIMEOUT"), /timed out/],
    [netErr("ENOTFOUND"), /DNS lookup failed \(ENOTFOUND\)/],
    [netErr("EAI_AGAIN"), /DNS lookup failed/],
    [netErr("ECONNREFUSED"), /connection refused/],
    [netErr("ECONNRESET"), /connection dropped/],
    [netErr("UNABLE_TO_VERIFY_LEAF_SIGNATURE_CERT"), /TLS certificate problem/],
    [new SyntaxError("Unexpected token"), /not valid JSON/],
    [new TypeError("fetch failed"), /network error \(fetch failed\)/],
    [new FetchFailure("HTTP 503", 3), /^HTTP 503$/],
  ];
  for (const [err, re] of cases) test(String(err.cause?.code || err.name || err.message), () => assert.match(explainFetchError(err), re));
});

describe("fetchJsonDetailed: retries what is worth retrying", () => {
  test("first-try success reports 1 attempt", async () => {
    const r = await fetchJsonDetailed("https://x.test", { fetchFn: seq(ok({ a: 1 })), sleep: noSleep });
    assert.deepEqual({ json: r.json, attempts: r.attempts }, { json: { a: 1 }, attempts: 1 });
  });
  test("503, 503, then success: 3 attempts, backing off 700ms then 1400ms", async () => {
    const waits = [];
    const r = await fetchJsonDetailed("https://x.test", { fetchFn: seq(new Response("", { status: 503 }), new Response("", { status: 503 }), ok({ a: 1 })), sleep: async (ms) => waits.push(ms) });
    assert.equal(r.attempts, 3); assert.deepEqual(waits, [700, 1400]);
  });
  test("a persistent 503 gives up after 3 attempts with the status in the reason", async () => {
    const f = seq(new Response("", { status: 503 }));
    await assert.rejects(fetchJsonDetailed("https://x.test", { fetchFn: f, sleep: noSleep }), (e) => e instanceof FetchFailure && e.reason === "HTTP 503" && e.attempts === 3);
    assert.equal(f.calls.length, 3);
  });
  test("403 and 404 are not retried", async () => {
    for (const [status, reason] of [[403, "HTTP 403 (blocked)"], [404, "HTTP 404"]]) {
      const f = seq(new Response("", { status }));
      await assert.rejects(fetchJsonDetailed("https://x.test", { fetchFn: f, sleep: noSleep }), (e) => e.reason === reason && e.attempts === 1);
      assert.equal(f.calls.length, 1);
    }
  });
  test("429 is retried and a short Retry-After is respected", async () => {
    const waits = [];
    const r = await fetchJsonDetailed("https://x.test", { fetchFn: seq(new Response("", { status: 429, headers: { "retry-after": "2" } }), ok({ a: 1 })), sleep: async (ms) => waits.push(ms) });
    assert.equal(r.attempts, 2); assert.deepEqual(waits, [2000]);
  });
  test("a network error is retried, then succeeds", async () => {
    const r = await fetchJsonDetailed("https://x.test", { fetchFn: seq(netErr("ECONNRESET"), ok({ a: 1 })), sleep: noSleep });
    assert.equal(r.attempts, 2);
  });
  test("a persistent network error reports the real cause", async () => {
    await assert.rejects(fetchJsonDetailed("https://x.test", { fetchFn: seq(netErr("ENOTFOUND")), sleep: noSleep }), (e) => /DNS lookup failed/.test(e.reason) && e.attempts === 3);
  });
  test("a body that is not JSON is not retried", async () => {
    const f = seq(new Response("<html>", { status: 200 }));
    await assert.rejects(fetchJsonDetailed("https://x.test", { fetchFn: f, sleep: noSleep }), (e) => e.reason === "response was not valid JSON" && e.attempts === 1);
    assert.equal(f.calls.length, 1);
  });
  test("retries: 0 means a single attempt", async () => {
    const f = seq(new Response("", { status: 503 }));
    await assert.rejects(fetchJsonDetailed("https://x.test", { fetchFn: f, sleep: noSleep, retries: 0 }), (e) => e.attempts === 1);
    assert.equal(f.calls.length, 1);
  });
});

describe("independent sources", () => {
  test("two DefiLlama endpoints are one source", () => {
    assert.equal(needFamily("defillama-protocols"), "DefiLlama");
    assert.equal(needFamily("defillama-dexs"), "DefiLlama");
    assert.equal(needFamily("mempool-fees"), "mempool.space");
    assert.equal(needFamily("wiki:Stablecoin"), "Wikipedia");
  });
  test("default minimum: 2 where two are declared, 1 where one is, 0 where none", () => {
    assert.equal(minSourcesFor({ needs: ["wiki:A", "defillama-protocols"] }, {}), 2);
    assert.equal(minSourcesFor({ needs: ["defillama-protocols", "defillama-dexs"] }, {}), 1);
    assert.equal(minSourcesFor({ needs: ["wiki:A"] }, {}), 1);
    assert.equal(minSourcesFor({ needs: [] }, {}), 0);
  });
  test("RESEARCH_MIN_SOURCES overrides, but never above what the topic declares", () => {
    const t = { needs: ["wiki:A", "defillama-protocols"] };
    assert.equal(minSourcesFor(t, { RESEARCH_MIN_SOURCES: "1" }), 1);
    assert.equal(minSourcesFor(t, { RESEARCH_MIN_SOURCES: "0" }), 0);
    assert.equal(minSourcesFor(t, { RESEARCH_MIN_SOURCES: "5" }), 2);
    assert.equal(minSourcesFor(t, { RESEARCH_MIN_SOURCES: "" }), 2);
    assert.equal(minSourcesFor(t, { RESEARCH_MIN_SOURCES: "abc" }), 2);
  });
  test("every shipped topic can actually be posted with its default minimum", () => {
    for (const t of RESEARCH_TOPICS) assert.ok(minSourcesFor(t, {}) <= new Set(t.needs.map(needFamily)).size, t.id);
  });
});

describe("gatherFacts: reasons, concept notes, parallelism", () => {
  const route = (map) => async (url) => {
    const k = Object.keys(map).find((x) => String(url).includes(x));
    if (!k) return new Response("", { status: 404 });
    const v = map[k];
    return typeof v === "function" ? v() : v;
  };
  const PROTOCOLS = () => ok([{ name: "Lido", symbol: "LDO", tvl: 33e9, change_1d: -0.6 }, { name: "Aave", symbol: "AAVE", tvl: 21e9, change_1d: 1.4 }]);

  test("each failure keeps its reason, attempts and timing", async () => {
    const f = route({ "api.llama.fi/protocols": () => new Response("", { status: 503 }), "mempool.space": () => new Response("", { status: 403 }) });
    const facts = await gatherFacts({ id: "t", needs: ["defillama-protocols", "mempool-fees"] }, { fetchFn: f, retries: 1, sleep: noSleep });
    const by = Object.fromEntries(facts.failures.map((b) => [b.need, b]));
    assert.equal(by["defillama-protocols"].error, "HTTP 503"); assert.equal(by["defillama-protocols"].attempts, 2);
    assert.equal(by["mempool-fees"].error, "HTTP 403 (blocked)"); assert.equal(by["mempool-fees"].attempts, 1);
    assert.deepEqual(facts.families, []);
  });
  test("a source that answers with nothing usable says so (it used to be an empty block with no reason)", async () => {
    const f = route({ "api.llama.fi/protocols": () => ok([]), "en.wikipedia.org": () => ok({ type: "disambiguation", title: "TVL" }) });
    const facts = await gatherFacts({ id: "t", needs: ["defillama-protocols", "wiki:TVL"] }, { fetchFn: f, sleep: noSleep });
    const msgs = facts.failures.map((b) => b.error);
    assert.ok(msgs.some((m) => /no protocols could be read \(the format may have changed\)/.test(m)), msgs.join("|"));
    assert.ok(msgs.some((m) => /no usable summary/.test(m)), msgs.join("|"));
  });
  test("concept notes are always in the facts, and are never credited as a source", async () => {
    const topic = { id: "t", needs: ["defillama-protocols"], defs: ["TVL is the total value of assets deposited in a protocol.", "It counts deposits, not trading."] };
    const facts = await gatherFacts(topic, { fetchFn: route({ "api.llama.fi/protocols": PROTOCOLS }), sleep: noSleep });
    assert.match(facts.factsText, /Concept notes: TVL is the total value of assets deposited in a protocol\. It counts deposits, not trading\./);
    assert.deepEqual(facts.sources, ["DefiLlama"]);
    assert.deepEqual(facts.families, ["DefiLlama"]);
    assert.equal(facts.blocks.find((b) => b.internal).source, "Concept notes");
  });
  test("concept notes survive every external source failing", async () => {
    const facts = await gatherFacts({ id: "t", needs: ["wiki:X"], defs: ["A definition."] }, { fetchFn: route({}), retries: 0 });
    assert.match(facts.factsText, /Concept notes: A definition\./);
    assert.deepEqual(facts.families, []);
  });
  test("sources are credited once even when a family answers twice", async () => {
    const dexs = () => ok({ protocols: [{ name: "Uniswap", volume24h: 3.1e9, change_1d: 4.2 }, { name: "Raydium", volume24h: 1.9e9, change_1d: -1.1 }], totalDataChart: [[1760000000, { volume: 8.4e9 }], [1760100000, { volume: 7.9e9 }]] });
    const f = route({ "api.llama.fi/protocols": PROTOCOLS, "api.llama.fi/overview/dexs": dexs });
    const facts = await gatherFacts({ id: "t", needs: ["defillama-protocols", "defillama-dexs"] }, { fetchFn: f, sleep: noSleep });
    assert.equal(facts.sources.filter((s) => s === "DefiLlama").length, 1);
    assert.equal(facts.families.length, 1);
  });
  test("sources are fetched in parallel, not one after another", async () => {
    let live = 0, peak = 0;
    const f = async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 15)); live--; return new Response("", { status: 404 }); };
    await gatherFacts({ id: "t", needs: ["defillama-protocols", "mempool-fees", "wiki:A"] }, { fetchFn: f, retries: 0 });
    assert.equal(peak, 3);
  });
  test("the article's 'numbers today' section never prints the concept notes block", async () => {
    const topic = RESEARCH_TOPICS.find((t) => t.id === "what-is-tvl");
    const facts = await gatherFacts(topic, { fetchFn: route({ "api.llama.fi/protocols": PROTOCOLS, "en.wikipedia.org": () => ok({ title: "Total value locked", extract: "TVL measures deposits." }) }), sleep: noSleep });
    const md = buildResearchArticleMarkdown({ copy: { hook: "What TVL measures", body: "TVL sums deposits.", takeaway: "It counts deposits." }, topic, facts, shares: [], disclaimer: "Not financial advice." });
    assert.doesNotMatch(md, /\*\*Concept notes\*\*/);
    assert.match(md, /\*\*DefiLlama\*\*/);
  });
});
