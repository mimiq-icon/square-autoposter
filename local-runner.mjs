// local-runner.mjs  (v10.1)
// ============================================================================
// The PC side of the news bot. Runs the same news pipeline as the GitHub
// workflow (RUN_MODE=news in post.mjs) in a loop every couple of minutes, so
// breaking stories go out in minutes instead of up to an hour.
//
// It is deliberately thin: each cycle is a child process (`node post.mjs`), so
// a crash, hang or memory leak in one cycle can't take the runner down, and
// there is exactly one copy of the news logic to maintain.
//
// Your PC does NOT need to be on 24/7. When it's off, the hourly GitHub
// workflow keeps posting. When both are up, the git claim lock in
// news-sync.mjs guarantees a story is only ever posted once.
//
// Usage:
//   node local-runner.mjs            run forever (Ctrl+C to stop)
//   node local-runner.mjs --once     one cycle, then exit
//   node local-runner.mjs --dry-run  loop, but publish nothing (safe preview)
//   node local-runner.mjs --check    check Node/git/Ollama/.env, then exit
// Normally you start it via start-news.bat (see PC-SETUP.md).
// ============================================================================
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { gitAvailable } from "./news-sync.mjs";
import { telegramConfigured } from "./telegram.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------- .env loading (no dependency) ----------

// Parses KEY=VALUE lines. Handles CRLF, a BOM, `export KEY=...`, quotes, and
// trailing "# comments" on unquoted values.
export function parseEnv(text) {
  const out = {};
  for (const rawLine of String(text).replace(/^﻿/, "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"') && v.length >= 2) || (v.startsWith("'") && v.endsWith("'") && v.length >= 2)) {
      v = v.slice(1, -1);
    } else {
      v = v.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]] = v;
  }
  return out;
}

// Real environment variables win over the file, like dotenv.
export function loadEnvFile(file, env = process.env) {
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { loaded: false, keys: [] }; }
  const parsed = parseEnv(text);
  const keys = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (env[k] === undefined || env[k] === "") { env[k] = v; keys.push(k); }
  }
  return { loaded: true, keys };
}

// ---------- scheduling ----------

// Normal: base ± 20% jitter (so we don't hit every feed on the same second
// forever). After failures: exponential backoff, capped at 15 minutes.
export function nextDelayMs(baseMs, failures = 0, rand = Math.random) {
  if (failures > 0) return Math.min(baseMs * 2 ** Math.min(failures, 8), 15 * 60_000);
  return Math.round(baseMs * (0.8 + rand() * 0.4));
}

// ---------- logging ----------

export function rotateLog(file, maxBytes = 5 * 1024 * 1024) {
  try {
    if (fs.statSync(file).size > maxBytes) fs.renameSync(file, `${file}.1`); // overwrites the old .1
  } catch { /* no log yet */ }
}

function makeLogger(logFile) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  rotateLog(logFile);
  return (line) => {
    const stamped = `[${new Date().toISOString().replace("T", " ").slice(0, 19)}] ${line}`;
    console.log(stamped);
    try { fs.appendFileSync(logFile, stamped + "\n"); } catch { /* logging must never crash the runner */ }
  };
}

// ---------- Ollama preflight ----------

// Returns { status: "ok" | "down" | "missing-model" | "unset", model?, error? }.
// Never throws. "down" is not fatal: the pipeline falls through to the next
// AI provider and finally the template, it just won't use the local model.
export async function checkOllama(env = process.env, fetchFn = fetch) {
  const model = env.OLLAMA_MODEL;
  if (!model) return { status: "unset" };
  const base = (env.OLLAMA_BASE_URL || "http://localhost:11434/v1").replace(/\/v1\/?$/, "");
  try {
    const res = await fetchFn(`${base}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { status: "down", model, error: `HTTP ${res.status}` };
    const json = await res.json();
    const names = (json.models || []).map((m) => m.name);
    const have = names.some((n) => n === model || n === `${model}:latest` || n.split(":")[0] === model);
    return have ? { status: "ok", model } : { status: "missing-model", model, installed: names };
  } catch (e) {
    return { status: "down", model, error: e.message };
  }
}

// ---------- one cycle ----------

// Runs `node post.mjs` once. spawnFn is injectable for tests.
// Resolves { code, timedOut }.
export function runCycle({ env, cwd = HERE, log, timeoutMs = 15 * 60_000, spawnFn = spawn, script = path.join(HERE, "post.mjs") }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn(process.execPath, [script], { cwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      log(`could not start node: ${e.message}`);
      return resolve({ code: 1, timedOut: false });
    }
    let timedOut = false;
    let buf = "";
    const flush = (final) => {
      const parts = buf.split(/\r?\n/);
      buf = final ? "" : parts.pop();
      for (const p of parts) if (p.trim()) log(`  ${p}`);
      if (final && buf) buf = "";
    };
    const onData = (d) => { buf += d.toString(); flush(false); };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      timedOut = true;
      log(`cycle exceeded ${Math.round(timeoutMs / 1000)}s — killing it`);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); log(`child error: ${e.message}`); resolve({ code: 1, timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); if (buf.trim()) log(`  ${buf.trim()}`); buf = ""; resolve({ code: code ?? 1, timedOut }); });
  });
}

// ---------- environment for the child ----------

export function buildChildEnv(baseEnv, { dryRun = false, gitOk = true, mode = "news" } = {}) {
  const env = { ...baseEnv, RUN_MODE: mode };
  env.NEWS_GIT_SYNC = env.NEWS_GIT_SYNC || (gitOk ? "true" : "false");
  env.NEWS_FEED_CACHE_FILE = env.NEWS_FEED_CACHE_FILE || path.join(".cache", "news-feeds.json");
  // Local model first on the PC; cloud providers remain as fallbacks.
  if (!env.AI_PROVIDER_ORDER && env.OLLAMA_MODEL) env.AI_PROVIDER_ORDER = "ollama,groq,openrouter,gemini";
  if (dryRun) env.DRY_RUN = "true"; // --dry-run forces it; otherwise a DRY_RUN in .env is respected
  return env;
}

// ---------- main ----------

export async function main(argv = process.argv.slice(2)) {
  const once = argv.includes("--once");
  const dryRun = argv.includes("--dry-run");
  const checkOnly = argv.includes("--check");

  const envInfo = loadEnvFile(path.join(HERE, ".env"));
  const log = makeLogger(path.join(HERE, "logs", "news.log"));
  const baseMs = Math.max(30, Number(process.env.NEWS_POLL_SEC) || 150) * 1000;
  const gitOk = gitAvailable(HERE);

  log(`square-autoposter news runner starting (poll ~${Math.round(baseMs / 1000)}s${dryRun ? ", DRY RUN" : ""}${once ? ", once" : ""})`);
  log(envInfo.loaded ? `loaded .env (${envInfo.keys.length} settings)` : `no .env file found — using only real environment variables`);

  const problems = [];
  if (!process.env.BINANCE_SQUARE_OPENAPI_KEY && !dryRun) problems.push("BINANCE_SQUARE_OPENAPI_KEY is not set (needed to publish)");
  if (!gitOk) log(`WARNING: this folder is not a git clone with an 'origin' remote. Without it the PC and GitHub cannot coordinate and the same story could be posted twice. Clone the repo (see PC-SETUP.md) rather than downloading the zip.`);
  const ol = await checkOllama(process.env);
  if (ol.status === "ok") log(`Ollama ready (model ${ol.model})`);
  else if (ol.status === "unset") log(`OLLAMA_MODEL not set — local model disabled; cloud providers/template will write the posts`);
  else if (ol.status === "missing-model") log(`WARNING: Ollama is running but model "${ol.model}" is not installed. Run: ollama pull ${ol.model}`);
  else log(`WARNING: Ollama not reachable (${ol.error}). Start the Ollama app; until then posts fall back to cloud AI or the plain-headline template.`);
  log(telegramConfigured() ? `Telegram approval: configured` : `Telegram approval: not configured (sensitive stories will wait for a second outlet instead)`);

  if (checkOnly) {
    for (const p of problems) log(`PROBLEM: ${p}`);
    log(problems.length || !gitOk ? "check finished with issues above" : "check passed");
    return problems.length ? 1 : 0;
  }
  if (problems.length) { for (const p of problems) log(`PROBLEM: ${p}`); return 1; }

  let stopping = false;
  let wake;
  const stop = () => { if (stopping) return; stopping = true; log("stopping after the current cycle..."); wake?.(); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  let failures = 0;
  while (!stopping) {
    const started = Date.now();
    const env = buildChildEnv({ ...process.env }, { dryRun, gitOk });
    const { code, timedOut } = await runCycle({ env, log });
    if (code === 0) failures = 0; else failures++;
    // v10.2: price alerts ("Bitcoin falls below $83,000") share the cycle. A
    // failure here is logged but never counts toward the news back-off.
    if (!/^(off|false|no|0)$/i.test(String(process.env.ALERTS_ENABLED || "").trim()) && !stopping) {
      const aStarted = Date.now();
      const alertEnv = buildChildEnv({ ...process.env }, { dryRun, gitOk, mode: "alerts" });
      const a = await runCycle({ env: alertEnv, log, timeoutMs: 5 * 60_000 });
      log(`alerts ${a.code === 0 ? "ok" : `FAILED (exit ${a.code}${a.timedOut ? ", timed out" : ""})`} in ${Math.round((Date.now() - aStarted) / 1000)}s`);
    }
    log(`cycle ${code === 0 ? "ok" : `FAILED (exit ${code}${timedOut ? ", timed out" : ""})`} in ${Math.round((Date.now() - started) / 1000)}s`);
    if (once || stopping) break;
    const delay = nextDelayMs(baseMs, failures);
    if (failures) log(`backing off ${Math.round(delay / 1000)}s after ${failures} failed cycle${failures > 1 ? "s" : ""}`);
    await new Promise((r) => { wake = r; setTimeout(r, delay); });
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
