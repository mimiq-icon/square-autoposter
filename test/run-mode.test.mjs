// test/run-mode.test.mjs — v11.3: the "run anything, dry by default" command.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, buildRunEnv, MODES } from "../run-mode.mjs";

test("parseArgs: mode, --live, KEY=VALUE extras", () => {
  assert.deepEqual(parseArgs(["research", "RESEARCH_MODE=article", "X=a=b"]), { name: "research", live: false, extra: { RESEARCH_MODE: "article", X: "a=b" }, error: null });
  assert.equal(parseArgs(["news", "--live"]).live, true);
  assert.equal(parseArgs(["news", "--live", "--dry-run"]).live, false);
  assert.match(parseArgs(["news", "alerts"]).error, /Unexpected/);
});

test("every mode maps to a RUN_MODE the bot understands", () => {
  assert.deepEqual(Object.keys(MODES).sort(), ["alerts", "daily", "digest", "news", "research", "weekly-approve", "weekly-draft", "weekly-publish"]);
  assert.equal(MODES.digest.mode, "top-movers-digest"); assert.equal(MODES.daily.mode, "");
});

test("buildRunEnv: dry by default, forced even if .env says DRY_RUN=false", () => {
  const e = buildRunEnv({ DRY_RUN: "false", GROQ_API_KEY: "k" }, { name: "alerts", live: false, extra: {}, gitOk: true });
  assert.equal(e.DRY_RUN, "true"); assert.equal(e.RUN_MODE, "alerts"); assert.equal(e.NEWS_GIT_SYNC, "true"); assert.equal(e.GROQ_API_KEY, "k");
});

test("buildRunEnv: --live does not set DRY_RUN; extras are applied; local model first when configured", () => {
  const e = buildRunEnv({ OLLAMA_MODEL: "qwen2.5:3b" }, { name: "research", live: true, extra: { RESEARCH_TOPIC: "what-is-tvl" }, gitOk: false });
  assert.equal(e.DRY_RUN, undefined); assert.equal(e.RESEARCH_TOPIC, "what-is-tvl"); assert.equal(e.NEWS_GIT_SYNC, "false");
  assert.equal(e.AI_PROVIDER_ORDER, "ollama,groq,openrouter,gemini");
});

test("buildRunEnv: a .env DRY_RUN=true survives --live only if you pass it explicitly", () => {
  assert.equal(buildRunEnv({ DRY_RUN: "true" }, { name: "news", live: true, extra: {}, gitOk: true }).DRY_RUN, undefined);
  assert.equal(buildRunEnv({}, { name: "news", live: true, extra: { DRY_RUN: "true" }, gitOk: true }).DRY_RUN, "true");
});
