import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lintStyle, lintLines, STYLE_GUIDE } from "../style.mjs";
import { ungroundedNames, validateNewsCopy, validateReaction, pickNewsDisclaimer, NEWS_DISCLAIMER_VARIANTS } from "../news.mjs";
import { buildNewsPrompt } from "../news.mjs";
import { buildAlertPrompt } from "../alerts.mjs";
import { buildResearchPrompt, parseResearchAiOutput } from "../research.mjs";
import { buildArticlePrompt } from "../article.mjs";
import { buildChildEnv } from "../local-runner.mjs";

describe("lintStyle: machine-written tells from real dry-run logs are caught", () => {
  const bad = [
    ["Ever wonder how much a coin can move in a day?", "opener"],
    ["How does rank #96 share the spotlight with crypto's top two assets?", null],
    ["Trending board features BTC and ETH as search interest splits between macro staples and smaller names.", "mood"],
    ["62 of the top 100 are green, not just one or two names carrying it.", "not-just"],
    ["It isn't just a price move, it is a repricing.", "not-just"],
    ["Bitcoin is more than just a coin.", "not-just"],
    ["Bitcoin rose 2% today. Which one are you keeping an eye on?", null],
    ["Bitcoin rose 2% today. Which one are you watching?", null],
    ["Bitcoin, the largest coin by value \u2014 rose 2% today.", "dash"],
    ["The move underscores a shift in the crypto landscape.", "filler"],
    ["Solana is a game-changer for payments.", "filler"],
    ["Here's the thing: volume dried up.", "opener"],
    ["The result? Volume dried up.", "reveal"],
    ["Bitcoin surged on massive volume.", "hype"],
    ["Stay tuned for more.", "filler"],
  ];
  for (const [text, rule] of bad) {
    test(`rejects: ${text.slice(0, 50)}`, () => {
      const r = lintStyle(text, { kind: "short" });
      assert.equal(r.ok, false, text);
      if (rule) assert.equal(r.rule, rule);
      assert.match(r.reason, /^style: /);
      assert.match(r.reason, /plain wire copy/);
    });
  }
});

describe("lintStyle: realistic wire copy passes", () => {
  const good = [
    "Bitcoin falls below $83,000 and now trades at $82,950.",
    "It is down 1.2% over the past 24 hours, with a 24h range of $81,900 to $84,249.",
    "The SEC delayed a decision on several spot altcoin ETF applications, according to Cointelegraph.",
    "Spot Ether ETFs recorded $955M in net outflows in October, according to Cointelegraph.",
    "Analyst Min Jung of Presto Labs sees a catch-up trade in altcoins.",
    "Fed officials held rates at 3\u20135% and said they would watch inflation data.",
    "SkyAI sold its remaining SOL over two days, according to the report.",
    "62 of the top 100 coins are green today.",
  ];
  for (const text of good) test(`accepts: ${text.slice(0, 50)}`, () => assert.deepEqual(lintStyle(text, { kind: "short" }), { ok: true }));

  test("a numeric range written with a dash is not a flourish", () => {
    assert.equal(lintStyle("Rates were held at 3\u20135% this week.", { kind: "short" }).ok, true);
  });
});

describe("lintStyle: kinds", () => {
  test("long-form may ask a question mid-text but never close on one", () => {
    assert.equal(lintStyle("Did volume follow the move? Not much. Volume fell 12% on the day.", { kind: "long" }).ok, true);
    assert.equal(lintStyle("Volume fell 12% on the day. What happens next?", { kind: "long" }).rule, "closing-question");
  });
  test("research posts take no questions and at most one dash", () => {
    assert.equal(lintStyle("What is TVL? It is the value of deposits.", { kind: "research" }).rule, "question");
    assert.equal(lintStyle("TVL \u2014 total value locked \u2014 sums deposits.", { kind: "research" }).rule, "dash");
    assert.equal(lintStyle("TVL sums deposits, priced in USD.", { kind: "research" }).ok, true);
  });
  test("lintLines names the offending line", () => {
    const r = lintLines({ headline: "Bitcoin falls below $83,000", context: "Which one are you watching?" });
    assert.equal(r.ok, false);
    assert.match(r.reason, /^context style:/);
  });
});

describe("name grounding: the false rejections from the dry-run log", () => {
  test("a curly apostrophe possessive is the same name", () => {
    const src = "Robinhood said it will list the token. Robinhood holds off on event contracts.";
    assert.deepEqual(ungroundedNames("Kalshi and Robinhood\u2019s plans were reported", "Kalshi and Robinhood hold off"), []);
    assert.deepEqual(ungroundedNames("the report named Robinhood\u2019s plans", src), []);
  });
  test("an expanded acronym is grounded when the source uses the acronym", () => {
    assert.deepEqual(ungroundedNames("regulators at the Securities and Exchange Commission delayed it", "The SEC delayed the ruling."), []);
  });
  test("and the acronym is grounded when the source spells it out", () => {
    assert.deepEqual(ungroundedNames("regulators said the SEC delayed it", "The Securities and Exchange Commission delayed the ruling."), []);
  });
  test("a genuinely unknown name is still rejected", () => {
    assert.deepEqual(ungroundedNames("the report said Blackstone Capital agreed", "The SEC delayed the ruling."), ["Blackstone", "Capital"]);
  });
  test("validateNewsCopy accepts both patterns end to end", () => {
    const src = "Robinhood and Kalshi hold off on event contracts after the SEC letter. Crypto.com sued Missouri.";
    const copy = {
      headline: "Crypto.com sues Missouri over event contracts as Kalshi holds off",
      detail: "Robinhood\u2019s event contracts stay on hold after a letter from the Securities and Exchange Commission.",
    };
    assert.deepEqual(validateNewsCopy(copy, src, []), { ok: true });
  });
  test("validateNewsCopy still rejects a closing question with a retryable reason", () => {
    const src = "Bitcoin fell below $83,000 on Tuesday.";
    const r = validateNewsCopy({ headline: "Bitcoin falls below $83,000 on Tuesday", context: "Which one are you watching?" }, src, []);
    assert.equal(r.ok, false);
    assert.equal(r.retryable, true);
    assert.match(r.reason, /context style:/);
  });
  test("validateReaction applies the same voice rules", () => {
    const src = "Analyst Min Jung of Presto Labs said altcoins could catch up.";
    assert.equal(validateReaction("Analyst Min Jung of Presto Labs said altcoins could catch up.", src, []).ok, true);
    assert.equal(validateReaction("Min Jung said this is not just a bounce but a repricing.", src, []).ok, false);
  });
});

describe("every writer carries the style guide and asks no question", () => {
  const cluster = { primary: { source: "CoinDesk", title: "Bitcoin falls below $83,000", summary: "Bitcoin fell on Tuesday." }, items: [] };
  const alert = { kind: "level", symbol: "BTC", name: "Bitcoin", dir: "down", level: 83000, price: 82950, change24h: -1.2, high24h: 84249, low24h: 81900 };
  const prompts = {
    news: buildNewsPrompt(cluster),
    alert: buildAlertPrompt(alert),
    research: buildResearchPrompt({ title: "What is TVL" }, "DefiLlama: TVL is $91.40B."),
    article: buildArticlePrompt("MARKET: cap $2.74T"),
  };
  for (const [name, p] of Object.entries(prompts)) {
    test(`${name} prompt includes the voice rules`, () => {
      assert.ok(STYLE_GUIDE.length >= 6);
      assert.match(p, /VOICE: write like a wire-service reporter/);
      assert.match(p, /No questions anywhere/);
    });
  }
  test("research prompt no longer requests a QUESTION line", () => {
    assert.doesNotMatch(prompts.research, /^QUESTION:/m);
    assert.match(prompts.research, /exactly three lines/);
  });
  test("a stray QUESTION line from a model is dropped, never posted", () => {
    const c = parseResearchAiOutput("HOOK: What TVL measures\nBODY: TVL sums deposits.\nTAKEAWAY: It counts deposits.\nQUESTION: What do you think?");
    assert.equal(c.question, null);
  });
});

describe("plain disclaimers and cloud-first order", () => {
  test("news disclaimer variants are plain, two of them, no dashes or slang", () => {
    assert.equal(NEWS_DISCLAIMER_VARIANTS.length, 2);
    for (const v of NEWS_DISCLAIMER_VARIANTS) {
      assert.match(v, /^Not financial advice\./);
      assert.doesNotMatch(v, /DYOR|NFA|[\u2014\u2013]/);
    }
    assert.notEqual(pickNewsDisclaimer(0), pickNewsDisclaimer(1));
  });
  test("the PC runner no longer forces the local model first", () => {
    assert.equal(buildChildEnv({ OLLAMA_MODEL: "qwen2.5:3b" }, { gitOk: true }).AI_PROVIDER_ORDER, undefined);
    assert.equal(buildChildEnv({ OLLAMA_MODEL: "qwen2.5:3b", AI_PROVIDER_ORDER: "ollama,groq" }, { gitOk: true }).AI_PROVIDER_ORDER, "ollama,groq");
  });
});
