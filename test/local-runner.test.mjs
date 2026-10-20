// test/local-runner.test.mjs — PC runner helpers. No network, no real Ollama.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "events";
import fs from "fs";
import os from "os";
import path from "path";
import { parseEnv, loadEnvFile, nextDelayMs, rotateLog, checkOllama, buildChildEnv, runCycle } from "../local-runner.mjs";

describe("parseEnv", () => {
  test("handles CRLF, BOM, quotes, export, comments", () => {
    const text = "﻿# comment\r\nA=1\r\nexport B=\"two words\"\r\nC='x#y'\r\nD=val # trailing\r\n\r\nbad line\r\nE=\r\n";
    assert.deepEqual(parseEnv(text), { A: "1", B: "two words", C: "x#y", D: "val", E: "" });
  });
  test("keeps = and # inside values without a leading space", () => {
    assert.deepEqual(parseEnv("URL=http://x/y?a=b#frag\nKEY=abc==\n"), { URL: "http://x/y?a=b#frag", KEY: "abc==" });
  });
  test("loadEnvFile never overrides a real environment variable", () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "env-")), ".env");
    fs.writeFileSync(f, "KEEP=file\nNEW=file\nEMPTY=file\n");
    const env = { KEEP: "real", EMPTY: "" };
    const r = loadEnvFile(f, env);
    assert.equal(env.KEEP, "real");
    assert.equal(env.NEW, "file");
    assert.equal(env.EMPTY, "file"); // blank counts as unset
    assert.equal(r.loaded, true);
    assert.equal(loadEnvFile(path.join(os.tmpdir(), "nope-" + Date.now()), {}).loaded, false);
  });
});

describe("nextDelayMs", () => {
  test("jitter stays within ±20% and failures back off to a 15 min cap", () => {
    assert.equal(nextDelayMs(100_000, 0, () => 0), 80_000);
    assert.equal(nextDelayMs(100_000, 0, () => 1), 120_000);
    assert.equal(nextDelayMs(100_000, 1), 200_000);
    assert.equal(nextDelayMs(100_000, 2), 400_000);
    assert.equal(nextDelayMs(100_000, 50), 15 * 60_000);
  });
});

test("rotateLog moves an oversized log aside and leaves a small one", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-"));
  const f = path.join(dir, "news.log");
  fs.writeFileSync(f, "x".repeat(50));
  rotateLog(f, 100);
  assert.ok(fs.existsSync(f));
  rotateLog(f, 10);
  assert.ok(!fs.existsSync(f));
  assert.ok(fs.existsSync(f + ".1"));
  rotateLog(path.join(dir, "missing.log")); // must not throw
});

describe("checkOllama", () => {
  const tags = (names) => async () => new Response(JSON.stringify({ models: names.map((name) => ({ name })) }), { status: 200 });
  test("unset when no model configured", async () => {
    assert.equal((await checkOllama({}, tags([]))).status, "unset");
  });
  test("ok, including the implicit :latest tag", async () => {
    assert.equal((await checkOllama({ OLLAMA_MODEL: "qwen2.5:3b" }, tags(["qwen2.5:3b"]))).status, "ok");
    assert.equal((await checkOllama({ OLLAMA_MODEL: "llama3.2" }, tags(["llama3.2:latest"]))).status, "ok");
  });
  test("missing model lists what is installed", async () => {
    const r = await checkOllama({ OLLAMA_MODEL: "qwen2.5:3b" }, tags(["llama3.2:3b"]));
    assert.equal(r.status, "missing-model");
    assert.deepEqual(r.installed, ["llama3.2:3b"]);
  });
  test("down when unreachable or non-200; derives the root from the /v1 base url", async () => {
    let url;
    const down = await checkOllama({ OLLAMA_MODEL: "m", OLLAMA_BASE_URL: "http://h:1234/v1" }, async (u) => { url = u; throw new Error("ECONNREFUSED"); });
    assert.equal(down.status, "down");
    assert.equal(url, "http://h:1234/api/tags");
    assert.equal((await checkOllama({ OLLAMA_MODEL: "m" }, async () => new Response("x", { status: 500 }))).status, "down");
  });
});

describe("buildChildEnv", () => {
  test("forces news mode, turns git sync on when git is there, puts Ollama first", () => {
    const e = buildChildEnv({ OLLAMA_MODEL: "qwen2.5:3b" }, { gitOk: true });
    assert.equal(e.RUN_MODE, "news");
    assert.equal(e.NEWS_GIT_SYNC, "true");
    assert.equal(e.AI_PROVIDER_ORDER, "ollama,groq,openrouter,gemini");
    assert.ok(e.NEWS_FEED_CACHE_FILE);
  });
  test("respects explicit settings; git sync off without git; --dry-run forces DRY_RUN", () => {
    const e = buildChildEnv({ NEWS_GIT_SYNC: "false", AI_PROVIDER_ORDER: "groq", OLLAMA_MODEL: "m" }, { gitOk: true });
    assert.equal(e.NEWS_GIT_SYNC, "false");
    assert.equal(e.AI_PROVIDER_ORDER, "groq");
    assert.equal(buildChildEnv({}, { gitOk: false }).NEWS_GIT_SYNC, "false");
    assert.equal(buildChildEnv({}, { dryRun: true }).DRY_RUN, "true");
  });
  test("a DRY_RUN=true in .env is NOT silently turned off", () => {
    assert.equal(buildChildEnv({ DRY_RUN: "true" }, {}).DRY_RUN, "true");
    assert.equal(buildChildEnv({}, {}).DRY_RUN, undefined);
  });
});

describe("runCycle", () => {
  const fakeSpawn = (script) => () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => { child.killed = true; setImmediate(() => child.emit("close", null)); };
    setImmediate(() => script(child));
    return child;
  };
  test("relays output line by line (even when split across chunks) and reports the exit code", async () => {
    const lines = [];
    const r = await runCycle({
      env: {}, log: (l) => lines.push(l),
      spawnFn: fakeSpawn((c) => { c.stdout.emit("data", "hel"); c.stdout.emit("data", "lo\nwor"); c.stderr.emit("data", "ld\n"); c.emit("close", 0); }),
    });
    assert.deepEqual(r, { code: 0, timedOut: false });
    assert.deepEqual(lines, ["  hello", "  world"]);
  });
  test("a non-zero exit is reported", async () => {
    const r = await runCycle({ env: {}, log: () => {}, spawnFn: fakeSpawn((c) => c.emit("close", 1)) });
    assert.equal(r.code, 1);
  });
  test("a hung cycle is killed after the timeout", async () => {
    let killed = false;
    const r = await runCycle({
      env: {}, log: () => {}, timeoutMs: 30,
      spawnFn: () => {
        const c = new EventEmitter(); c.stdout = new EventEmitter(); c.stderr = new EventEmitter();
        c.kill = () => { killed = true; setImmediate(() => c.emit("close", null)); };
        return c;
      },
    });
    assert.equal(r.timedOut, true);
    assert.equal(killed, true);
    assert.equal(r.code, 1);
  });
  test("a spawn failure does not throw", async () => {
    const r = await runCycle({ env: {}, log: () => {}, spawnFn: () => { throw new Error("ENOENT"); } });
    assert.equal(r.code, 1);
  });
});

describe("buildChildEnv mode (v10.2)", () => {
  test("defaults to news; mode=alerts sets RUN_MODE=alerts and keeps git sync", () => {
    assert.equal(buildChildEnv({}, {}).RUN_MODE, "news");
    const e = buildChildEnv({}, { mode: "alerts", gitOk: true });
    assert.equal(e.RUN_MODE, "alerts"); assert.equal(e.NEWS_GIT_SYNC, "true");
  });
});
