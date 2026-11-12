// test/news-disclaimer.test.mjs — v10.2
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { assembleNewsPost, resolveNewsDisclaimer, DEFAULT_NEWS_DISCLAIMER } from "../news.mjs";

const base = { headline: "ETH ETFs lose $955M in Oct", context: null, sources: ["Cointelegraph"], score: 61, ageMinutes: 10, cashtags: ["$BTC", "$ETH"], hashtags: ["#Bitcoin", "#Ethereum"] };

describe("resolveNewsDisclaimer", () => {
  test("unset or empty => the default line", () => {
    assert.equal(resolveNewsDisclaimer(undefined), DEFAULT_NEWS_DISCLAIMER);
    assert.equal(resolveNewsDisclaimer(""), DEFAULT_NEWS_DISCLAIMER);
    assert.equal(resolveNewsDisclaimer("   "), DEFAULT_NEWS_DISCLAIMER);
  });
  test("off / none / false / no / 0 remove it (any case)", () => {
    for (const v of ["off", "OFF", "none", "False", "no", "0"]) assert.equal(resolveNewsDisclaimer(v), "");
  });
  test("custom text is used, whitespace collapsed, capped at 80 chars", () => {
    assert.equal(resolveNewsDisclaimer("  NFA.   DYOR  "), "NFA. DYOR");
    assert.equal(resolveNewsDisclaimer("x".repeat(200)).length, 80);
  });
});

describe("assembleNewsPost disclaimer", () => {
  test("no disclaimer argument => output identical to before (backward compatible)", () => {
    const t = assembleNewsPost(base);
    assert.doesNotMatch(t, /financial advice/i);
    assert.match(t, /Source: Cointelegraph\n\$BTC \$ETH #Bitcoin #Ethereum$/);
  });
  test("disclaimer sits between the source line and the tag line", () => {
    const t = assembleNewsPost({ ...base, disclaimer: DEFAULT_NEWS_DISCLAIMER });
    assert.match(t, /Source: Cointelegraph\nNot financial advice\.\n\$BTC \$ETH #Bitcoin #Ethereum$/);
  });
  test("disclaimer adds no cashtags or hashtags", () => {
    const t = assembleNewsPost({ ...base, disclaimer: "Not financial advice." });
    assert.equal((t.match(/\$[A-Z]{2,6}\b/g) || []).length, 2);
    assert.equal((t.match(/#\w+/g) || []).length, 2);
  });
});
