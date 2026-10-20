// test/news-disclaimer.test.mjs — v10.2
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assembleNewsPost, resolveNewsDisclaimer, NEWS_DISCLAIMER_VARIANTS } from "../news.mjs";

const base = { headline: "ETH ETFs lose $955M in Oct", context: null, sources: ["Cointelegraph"], score: 61, ageMinutes: 10, cashtags: ["$BTC", "$ETH"], hashtags: ["#Bitcoin", "#Ethereum"] };

describe("resolveNewsDisclaimer", () => {
  test("unset/empty => one of the built-in variants, same story => same line", () => {
    const a = resolveNewsDisclaimer(undefined, "Story A");
    assert.ok(NEWS_DISCLAIMER_VARIANTS.includes(a));
    assert.equal(resolveNewsDisclaimer("", "Story A"), a);
    assert.equal(resolveNewsDisclaimer("   ", "Story A"), a);
  });
  test("different stories rotate through different lines", () => {
    const seen = new Set();
    for (let i = 0; i < 60; i++) seen.add(resolveNewsDisclaimer(undefined, `headline number ${i}`));
    assert.ok(seen.size >= 4, `only ${seen.size} distinct lines`);
    for (const s of seen) assert.ok(NEWS_DISCLAIMER_VARIANTS.includes(s));
  });
  test("off / none / false / no / 0 remove it (any case)", () => {
    for (const v of ["off", "OFF", "none", "False", "no", "0"]) assert.equal(resolveNewsDisclaimer(v, "x"), "");
  });
  test("custom text is used, whitespace collapsed, capped at 80 chars", () => {
    assert.equal(resolveNewsDisclaimer("  NFA.   DYOR  ", "x"), "NFA. DYOR");
    assert.equal(resolveNewsDisclaimer("x".repeat(200), "x").length, 80);
  });
  test("several custom options separated by | rotate among themselves", () => {
    const seen = new Set();
    for (let i = 0; i < 40; i++) seen.add(resolveNewsDisclaimer("One. | Two. | Three.", `s${i}`));
    assert.deepEqual([...seen].sort(), ["One.", "Three.", "Two."]);
  });
});

describe("assembleNewsPost disclaimer", () => {
  test("no disclaimer argument => output identical to before (backward compatible)", () => {
    const t = assembleNewsPost(base);
    assert.doesNotMatch(t, /advice|DYOR|research/i);
    assert.match(t, /Source: Cointelegraph\n\$BTC \$ETH #Bitcoin #Ethereum$/);
  });
  test("disclaimer sits between the source line and the tag line", () => {
    const t = assembleNewsPost({ ...base, disclaimer: "Not financial advice." });
    assert.match(t, /Source: Cointelegraph\nNot financial advice\.\n\$BTC \$ETH #Bitcoin #Ethereum$/);
  });
  test("disclaimer adds no cashtags or hashtags", () => {
    const t = assembleNewsPost({ ...base, disclaimer: "DYOR. Not investment advice." });
    assert.equal((t.match(/\$[A-Z]{2,6}\b/g) || []).length, 2);
    assert.equal((t.match(/#\w+/g) || []).length, 2);
  });
});
