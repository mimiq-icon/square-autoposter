// test/news.test.mjs — pure, no-network tests for news.mjs
// Run: node --test
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseExtraFeeds, decodeEntities, cleanText, parseFeed, detectCoins, titleTokens, sameStory,
  isJunkTitle, filterFreshNews, clusterStories, scoreStory, emptyNewsState, normalizeNewsState,
  pruneNewsState, dailyCount, recordPosted, isAlreadyPosted, pickNewsStory, buildNewsPrompt,
  parseNewsAiOutput, extractQuantities, validateNewsCopy, truncateAtWord, buildNewsTemplate,
  assembleNewsPost, isSensitiveStory, resolveApprovalMode, decideNewsAction, recordClaim,
  setEntryStatus, removeClaim, gapBlock, NEWS_FEEDS, CRYPTO_RELEVANT, MACRO_RELEVANT,
} from "../news.mjs";

const NOW = Date.parse("2026-10-18T08:00:00Z");
const minsAgo = (m) => NOW - m * 60000;

const item = (title, source, mins, summary = "", link = "") => ({
  title, source, publishedAt: minsAgo(mins), summary, link: link || `https://x.test/${encodeURIComponent(title)}`,
});

const RSS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:media="http://search.yahoo.com/mrss/">
<channel><title>Feed</title>
<item>
  <title><![CDATA[SEC approves spot Solana ETF &amp; staking]]></title>
  <link>https://example.com/a</link>
  <pubDate>Sun, 18 Oct 2026 07:30:00 GMT</pubDate>
  <media:title>IGNORE ME</media:title>
  <description><![CDATA[<p>The regulator cleared the fund on Sunday.</p> <p>The post SEC approves spot Solana ETF appeared first on Example.</p>]]></description>
</item>
<item>
  <title>BTC &lt; $60k? Not so fast &#8211; analysts</title>
  <link>https://example.com/b</link>
  <pubDate>Sun, 18 Oct 2026 07:00:00 GMT</pubDate>
  <description>&lt;b&gt;Bold&lt;/b&gt; text &amp;amp; more</description>
</item>
<item><title></title><link>https://example.com/empty</link></item>
</channel></rss>`;

const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom">
<entry>
  <title>Binance lists new token</title>
  <link rel="self" href="https://example.com/self"/>
  <link rel="alternate" href="https://example.com/alt?a=1&amp;b=2"/>
  <published>2026-10-18T07:45:00Z</published>
  <summary>Trading opens Monday.</summary>
</entry>
</feed>`;

describe("feed parsing", () => {
  test("decodeEntities handles named, decimal and hex entities and leaves unknown ones", () => {
    assert.equal(decodeEntities("AT&amp;T &#8211; &#x2014; &bogus;"), "AT&T – — &bogus;");
  });

  test("cleanText unwraps CDATA, strips tags, keeps a bare '<' in a headline", () => {
    assert.equal(cleanText("<![CDATA[<p>Hello <b>world</b></p>]]>"), "Hello world");
    assert.equal(cleanText("BTC < $60k today"), "BTC < $60k today");
  });

  test("parses RSS: CDATA title, entities, boilerplate stripped, media:title ignored", () => {
    const items = parseFeed(RSS, "Example");
    assert.equal(items.length, 2); // empty-title item dropped
    assert.equal(items[0].title, "SEC approves spot Solana ETF & staking");
    assert.equal(items[0].link, "https://example.com/a");
    assert.equal(items[0].publishedAt, Date.parse("2026-10-18T07:30:00Z"));
    assert.equal(items[0].summary, "The regulator cleared the fund on Sunday.");
    assert.equal(items[0].source, "Example");
    assert.equal(items[1].summary, "Bold text & more");
  });

  test("parses Atom and prefers the alternate link", () => {
    const [e] = parseFeed(ATOM, "Atomic");
    assert.equal(e.title, "Binance lists new token");
    assert.equal(e.link, "https://example.com/alt?a=1&b=2");
    assert.equal(e.publishedAt, Date.parse("2026-10-18T07:45:00Z"));
  });

  test("garbage / empty input yields no items and never throws", () => {
    assert.deepEqual(parseFeed("", "x"), []);
    assert.deepEqual(parseFeed(null, "x"), []);
    assert.deepEqual(parseFeed("<html>blocked by cloudflare</html>", "x"), []);
  });

  test("an item with an unparseable date gets publishedAt null", () => {
    const [i] = parseFeed("<rss><item><title>Some long enough title here</title><pubDate>nope</pubDate></item></rss>", "x");
    assert.equal(i.publishedAt, null);
  });

  test("parseExtraFeeds accepts Name|https URLs only", () => {
    assert.deepEqual(parseExtraFeeds("A|https://a.test/rss, B|http://insecure.test, junk, |https://c.test"), [
      { name: "A", url: "https://a.test/rss" },
    ]);
    assert.deepEqual(parseExtraFeeds(undefined), []);
  });
});

describe("detectCoins", () => {
  test("detects by name and by case-sensitive ticker", () => {
    assert.deepEqual(detectCoins("Bitcoin and ETH rally"), ["BTC", "ETH"]);
    assert.deepEqual(detectCoins("the sol of the day, ada was here"), []);
    assert.deepEqual(detectCoins("SOL surges"), ["SOL"]);
  });

  test("'Bitcoin Cash' is BCH, not BTC", () => {
    assert.deepEqual(detectCoins("Bitcoin Cash upgrade"), ["BCH"]);
  });
});

describe("same-story detection", () => {
  test("same event, different wording", () => {
    assert.ok(sameStory("SEC approves spot Solana ETF from Grayscale", "Grayscale's Solana ETF wins SEC approval"));
  });
  test("different coins are never merged even with similar words", () => {
    assert.equal(sameStory("Bitcoin ETF sees record inflows", "Ethereum ETF sees record inflows"), false);
  });
  test("conflicting dollar figures are never merged", () => {
    assert.equal(sameStory("Hacker steals $50 million from lender", "Hacker steals $9 million from lender"), false);
  });
  test("unrelated headlines are not merged", () => {
    assert.equal(sameStory("Fed holds rates steady", "Coinbase launches new exchange in Brazil"), false);
  });
  test("titleTokens drops stopwords and single characters", () => {
    assert.deepEqual([...titleTokens("The SEC is on a roll")].sort(), ["roll", "sec"]);
  });
});

describe("filtering", () => {
  test("junk titles", () => {
    assert.ok(isJunkTitle("Bitcoin price prediction: where next for BTC"));
    assert.ok(isJunkTitle("Will Solana ever flip Ethereum this cycle?"));
    assert.ok(isJunkTitle("How to buy Bitcoin in five easy steps today"));
    assert.ok(isJunkTitle("Short one"));
    assert.equal(isJunkTitle("SEC approves first spot Solana ETF in the US"), false);
  });

  test("drops stale, future-dated, undated and junk items", () => {
    const items = [
      item("SEC approves first spot Solana ETF in the US", "A", 30),
      item("Old news about a very old announcement here", "A", 60 * 10),
      item("Future dated headline that cannot be trusted", "A", -60),
      { ...item("Undated headline with no published timestamp", "A", 5), publishedAt: null },
      item("Top 10 crypto to buy before the weekend ends", "A", 10),
    ];
    const out = filterFreshNews(items, NOW, 6);
    assert.deepEqual(out.map((i) => i.title), ["SEC approves first spot Solana ETF in the US"]);
  });
});

describe("clustering and scoring", () => {
  const a = item("SEC approves spot Solana ETF from Grayscale", "CoinDesk", 40, "The regulator cleared the fund.");
  const b = item("Grayscale's Solana ETF wins SEC approval", "Decrypt", 20, "");
  const c = item("Fed holds interest rates steady at meeting", "Decrypt", 90, "Powell spoke after the decision.");

  test("merges the same story across outlets and picks the richest summary as primary", () => {
    const clusters = clusterStories([a, b, c]);
    assert.equal(clusters.length, 2);
    const sol = clusters.find((x) => x.items.length === 2);
    assert.deepEqual(sol.sources.sort(), ["CoinDesk", "Decrypt"]);
    assert.equal(sol.primary, a);
    assert.equal(sol.firstSeen, a.publishedAt);
  });

  test("multi-outlet, high-impact, fresh stories outscore a single quiet one", () => {
    const [sol, fed] = [clusterStories([a, b])[0], clusterStories([c])[0]];
    const hot = scoreStory(sol, NOW);
    const quiet = scoreStory(fed, NOW);
    assert.ok(hot.score > quiet.score, `${hot.score} vs ${quiet.score}`);
    assert.ok(hot.reasons.some((r) => /2 outlets/.test(r)));
  });

  test("speculative wording is penalised", () => {
    const spec = clusterStories([item("Analysts say Bitcoin could reach new heights soon", "X", 10)])[0];
    assert.ok(scoreStory(spec, NOW).reasons.some((r) => /speculative/.test(r)));
  });
});

describe("state and selection", () => {
  const items = [
    item("SEC approves spot Solana ETF from Grayscale", "CoinDesk", 40, "The regulator cleared the fund."),
    item("Grayscale's Solana ETF wins SEC approval", "Decrypt", 20),
    item("Minor wallet adds a dark mode feature option", "Decrypt", 15),
  ];

  test("picks the strongest story and respects minScore", () => {
    const r = pickNewsStory(items, emptyNewsState(), { nowMs: NOW });
    assert.match(r.choice.cluster.primary.title, /Solana ETF/);
    assert.equal(pickNewsStory(items, emptyNewsState(), { nowMs: NOW, minScore: 999 }).choice, null);
  });

  test("skips stories already posted, even when another outlet words them differently", () => {
    const first = pickNewsStory(items, emptyNewsState(), { nowMs: NOW }).choice.cluster;
    const state = recordPosted(emptyNewsState(), first, NOW);
    const later = [item("Solana ETF approved by SEC, Grayscale confirms", "The Block", 5), ...items.slice(2)];
    const r = pickNewsStory(later, state, { nowMs: NOW + 600000 });
    assert.ok(!r.choice || !/Solana/.test(r.choice.cluster.primary.title));
  });

  test("isAlreadyPosted matches on identical link", () => {
    const state = recordPosted(emptyNewsState(), clusterStories([items[0]])[0], NOW);
    const other = clusterStories([{ ...items[2], link: items[0].link }])[0];
    assert.ok(isAlreadyPosted(other, state));
  });

  test("daily counter increments and rolls over at UTC midnight", () => {
    let s = recordPosted(emptyNewsState(), clusterStories([items[0]])[0], NOW);
    s = recordPosted(s, clusterStories([items[2]])[0], NOW + 1000);
    assert.equal(dailyCount(s, NOW), 2);
    assert.equal(dailyCount(s, NOW + 24 * 3600 * 1000), 0);
  });

  test("pruneNewsState drops old entries and normalizeNewsState survives garbage", () => {
    const s = { posted: [{ title: "old", at: NOW - 100 * 3600000 }, { title: "new", at: NOW - 3600000 }] };
    assert.deepEqual(pruneNewsState(s, NOW).posted.map((p) => p.title), ["new"]);
    assert.deepEqual(normalizeNewsState("nope"), emptyNewsState());
    assert.deepEqual(normalizeNewsState({ posted: [{ bad: 1 }, { title: "ok", at: 5 }] }).posted, [{ title: "ok", at: 5, status: "posted" }]);
    // old-format files (with a stored daily counter) still load
    assert.deepEqual(normalizeNewsState({ posted: [], daily: { date: "x", count: 3 } }), { posted: [] });
  });
});

describe("AI copy: prompt, parse, validate", () => {
  const src = "SEC approves spot Solana ETF from Grayscale. The regulator cleared the $1.2 billion fund on Sunday, Gary Gensler said. SOL rose 5%.";

  test("prompt fences the untrusted story and forbids invention", () => {
    const p = buildNewsPrompt(clusterStories([item("SEC approves spot Solana ETF from Grayscale", "CoinDesk", 10, "Cleared Sunday.")])[0]);
    assert.match(p, /UNTRUSTED DATA/);
    assert.match(p, /=== STORY START ===[\s\S]*=== STORY END ===/);
    assert.match(p, /Never add numbers, names/);
  });

  test("parseNewsAiOutput handles quotes, NONE and missing headline", () => {
    // v11: the parser now also reads DETAIL and REACTION lines; both are
    // null when absent or NONE.
    assert.deepEqual(parseNewsAiOutput('HEADLINE: "SEC clears Grayscale Solana ETF"\nCONTEXT: NONE'), {
      headline: "SEC clears Grayscale Solana ETF", context: null, detail: null, reaction: null,
    });
    assert.deepEqual(parseNewsAiOutput("headline: A thing happened today\ncontext: It cost $1.2 billion."), {
      headline: "A thing happened today", context: "It cost $1.2 billion.", detail: null, reaction: null,
    });
    assert.equal(parseNewsAiOutput("Here is your headline!"), null);
  });

  test("extractQuantities understands units", () => {
    assert.deepEqual(extractQuantities("$1.2 billion, 5%, 100k and 10 BTC in 5 months"), [
      { value: "1.2", unit: "B" }, { value: "5", unit: "%" }, { value: "100", unit: "K" },
      { value: "10", unit: "" }, { value: "5", unit: "" },
    ]);
  });

  test("accepts a grounded rewrite", () => {
    const r = validateNewsCopy({ headline: "SEC clears Grayscale's spot Solana ETF worth $1.2 billion", context: "SOL rose 5% on the news." }, src);
    assert.deepEqual(r, { ok: true });
  });

  test("rejects an invented number, a wrong unit, an invented name and an invented coin", () => {
    assert.match(validateNewsCopy({ headline: "SEC clears Grayscale Solana ETF worth $3 billion" }, src).reason, /not in the source/);
    assert.match(validateNewsCopy({ headline: "SEC clears Grayscale Solana ETF worth $1.2 million" }, src).reason, /not in the source/);
    assert.match(validateNewsCopy({ headline: "SEC clears Grayscale Solana ETF as Vitalik cheers" }, src).reason, /names not in the source/);
    assert.match(validateNewsCopy({ headline: "SEC clears Grayscale Solana ETF while Dogecoin lags" }, src).reason, /coin not in the source/);
  });

  test("rejects links, hashtags, cashtags, emoji, hype punctuation, lead-ins", () => {
    const base = "SEC clears Grayscale spot Solana ETF on Sunday";
    for (const bad of [`${base} https://x.co`, `${base} #SOL`, `${base} $SOL`, `${base} 🚀`, `${base}!`, `BREAKING ${base}`]) {
      assert.equal(validateNewsCopy({ headline: bad }, src).ok, false, bad);
    }
  });

  test("rejects predictions, advice and banned phrases", () => {
    assert.match(validateNewsCopy({ headline: "SEC clears Grayscale Solana ETF and SOL will skyrocket" }, src).reason, /prediction/);
    assert.match(validateNewsCopy({ headline: "SEC clears Grayscale Solana ETF, you should buy SOL" }, src).reason, /advice/);
    assert.match(validateNewsCopy({ headline: "SEC clears Grayscale Solana ETF, a buying opportunity" }, src, ["buying opportunity"]).reason, /banned/);
  });

  test("rejects out-of-range headline length", () => {
    assert.equal(validateNewsCopy({ headline: "Too short" }, src).ok, false);
    assert.equal(validateNewsCopy({ headline: "x".repeat(170) }, src).ok, false);
  });
});

describe("template and assembly", () => {
  test("template strips a trailing '| Publisher' suffix only when it is the publisher", () => {
    const c = clusterStories([item("SEC approves spot Solana ETF | CoinDesk", "CoinDesk", 5)])[0];
    assert.equal(buildNewsTemplate(c).headline, "SEC approves spot Solana ETF");
    const d = clusterStories([item("SEC approves spot Solana ETF | Other Outlet", "CoinDesk", 5)])[0];
    assert.equal(buildNewsTemplate(d).headline, "SEC approves spot Solana ETF | Other Outlet");
  });

  test("truncateAtWord ends on a word with an ellipsis", () => {
    const t = truncateAtWord("alpha beta gamma delta epsilon zeta", 20);
    assert.ok(t.length <= 20 && t.endsWith("…"), t);
  });

  test("assemble: high score is BREAKING, low is JUST IN; source/sources; tag caps", () => {
    const hi = assembleNewsPost({ headline: "H", context: "C", sources: ["A", "B", "C"], score: 70, cashtags: ["$BTC", "$ETH", "$SOL", "$ADA"], hashtags: ["#Bitcoin", "#Ethereum", "#X"] });
    assert.match(hi, /^🚨 BREAKING: H\n\nC\n\nSources: A, B\n\$BTC \$ETH \$SOL #Bitcoin #Ethereum$/);
    const lo = assembleNewsPost({ headline: "H", context: null, sources: ["A"], score: 40 });
    assert.equal(lo, "⚡ JUST IN: H\n\nSource: A");
  });
});

describe("official feeds and relevance filters", () => {
  test("official feeds carry a filter so unrelated releases are dropped", () => {
    const official = NEWS_FEEDS.filter((f) => f.official);
    assert.ok(official.length >= 1);
    for (const f of official) assert.ok(f.filter instanceof RegExp, f.name);
  });
  test("filters", () => {
    assert.ok(CRYPTO_RELEVANT.test("SEC charges founder of crypto lending platform"));
    assert.ok(CRYPTO_RELEVANT.test("Statement on spot bitcoin ETFs"));
    assert.equal(CRYPTO_RELEVANT.test("SEC charges adviser with custody rule violations"), false);
    assert.ok(MACRO_RELEVANT.test("Federal Reserve issues FOMC statement"));
    assert.equal(MACRO_RELEVANT.test("Agencies finalize bank capital rule"), false);
  });
  test("an official source adds score and marks the cluster", () => {
    const c = clusterStories([{ ...item("SEC approves spot Solana ETF from Grayscale", "SEC", 10, "x"), official: true }])[0];
    assert.equal(c.hasOfficial, true);
    assert.ok(scoreStory(c, NOW).reasons.some((r) => /official/.test(r)));
  });
});

describe("sensitive claims and the approval decision", () => {
  const one = (t, src = "A", extra = {}) => clusterStories([{ ...item(t, src, 10), ...extra }])[0];
  test("detects sensitive claims", () => {
    for (const t of ["Exchange hacked for $40 million in overnight exploit", "Founder arrested in Dubai over fraud case",
      "Stablecoin depegs as reserves questioned", "Lender files for bankruptcy protection today"]) {
      assert.ok(isSensitiveStory(one(t)), t);
    }
    assert.equal(isSensitiveStory(one("Coinbase launches new exchange in Brazil today")), false);
  });
  test("a sensitive claim from one outlet waits; two outlets or an official source may proceed", () => {
    const t = "Exchange hacked for $40 million in overnight exploit";
    assert.equal(decideNewsAction(one(t)).action, "wait");
    const two = clusterStories([item(t, "A", 10), item("Overnight exploit drains $40 million from exchange hacked", "B", 8)])[0];
    assert.equal(decideNewsAction(two).action, "post");
    assert.equal(decideNewsAction(one(t, "SEC", { official: true })).action, "post");
  });
  test("approval modes", () => {
    const sens = clusterStories([item("Exchange hacked for $40 million in overnight exploit", "A", 10), item("Overnight exploit drains $40 million from exchange hacked", "B", 8)])[0];
    const calm = one("Coinbase launches new exchange in Brazil today");
    assert.equal(decideNewsAction(sens, { approvalMode: "sensitive", telegramConfigured: true }).action, "approve");
    assert.equal(decideNewsAction(calm, { approvalMode: "sensitive", telegramConfigured: true }).action, "post");
    assert.equal(decideNewsAction(calm, { approvalMode: "all", telegramConfigured: true }).action, "approve");
    assert.equal(decideNewsAction(sens, { approvalMode: "off", telegramConfigured: true }).action, "post");
  });
  test("fails closed when approval is required but there is no channel", () => {
    assert.equal(decideNewsAction(one("Coinbase launches new exchange in Brazil today"), { approvalMode: "all", telegramConfigured: false }).action, "skip");
  });
  test("resolveApprovalMode defaults on Telegram, honours explicit values", () => {
    assert.equal(resolveApprovalMode("", true), "sensitive");
    assert.equal(resolveApprovalMode(undefined, false), "off");
    assert.equal(resolveApprovalMode("ALL", false), "all");
    assert.equal(resolveApprovalMode("nonsense", true), "sensitive");
  });
  test("a held-back story does not block the next best one", () => {
    const items = [
      item("Exchange hacked for $40 million in overnight exploit", "A", 10, "Funds drained."),
      item("SEC approves spot Solana ETF from Grayscale", "A", 12, "Cleared."),
    ];
    const r = pickNewsStory(items, emptyNewsState(), { nowMs: NOW, minScore: 20 });
    assert.match(r.choice.cluster.primary.title, /Solana ETF/);
    assert.ok(r.ranked.some((x) => x.decision.action === "wait"));
  });
});

describe("claim-style shared state", () => {
  const story = clusterStories([item("SEC approves spot Solana ETF from Grayscale", "CoinDesk", 10)])[0];
  test("claims carry a status and any status blocks re-picking", () => {
    for (const st of ["posted", "pending", "skipped"]) {
      const s = recordClaim(emptyNewsState(), story, NOW, st);
      assert.equal(s.posted[0].status, st);
      assert.ok(isAlreadyPosted(story, s));
    }
  });
  test("setEntryStatus promotes pending to posted; removeClaim reverts", () => {
    let s = recordClaim(emptyNewsState(), story, NOW, "pending");
    s = setEntryStatus(s, story, "posted");
    assert.equal(s.posted.length, 1);
    assert.equal(s.posted[0].status, "posted");
    assert.equal(removeClaim(s, story).posted.length, 0);
  });
  test("only posted entries count toward the daily cap", () => {
    let s = recordClaim(emptyNewsState(), story, NOW, "pending");
    assert.equal(dailyCount(s, NOW), 0);
    s = setEntryStatus(s, story, "posted");
    assert.equal(dailyCount(s, NOW), 1);
  });
  test("two writers' entries merge into one count (no stored counter to conflict)", () => {
    const other = clusterStories([item("Fed holds interest rates steady at meeting", "Decrypt", 5)])[0];
    const s = recordClaim(recordClaim(emptyNewsState(), story, NOW - 1000), other, NOW);
    assert.equal(dailyCount(s, NOW), 2);
  });
  test("gapBlock enforces a minimum gap and a single pending draft", () => {
    const posted = recordClaim(emptyNewsState(), story, NOW - 2 * 60000, "posted");
    assert.match(gapBlock(posted, NOW, { minGapMin: 5 }), /minimum gap/);
    assert.equal(gapBlock(posted, NOW, { minGapMin: 1 }), null);
    assert.equal(gapBlock(posted, NOW, { minGapMin: 0 }), null);
    const pending = recordClaim(emptyNewsState(), story, NOW - 60000, "pending");
    assert.match(gapBlock(pending, NOW, { minGapMin: 0 }), /waiting on approval/);
    assert.equal(gapBlock(pending, NOW + 30 * 60000, { minGapMin: 0 }), null); // stale pending expires
  });
});

describe("lead-in depends on story age", () => {
  test("old stories are never labelled BREAKING", () => {
    const mk = (age, score) => assembleNewsPost({ headline: "H", sources: ["A"], score, ageMinutes: age });
    assert.match(mk(10, 80), /BREAKING/);
    assert.match(mk(75, 80), /JUST IN/);
    assert.match(mk(200, 80), /NEWS:/);
    assert.doesNotMatch(mk(200, 80), /BREAKING|JUST IN/);
  });
});
