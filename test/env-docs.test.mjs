import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// Why this exists: .env.example has silently gone stale twice. Once it was the
// 42-line v10 file (no alert, research, card or SEC settings, and a
// NEWS_MAX_PER_DAY that said 12 when the code said 40); the second time it
// happened again after "docs brought back in line". Nothing failed either time.
// Now it does: every setting the code reads must appear in .env.example.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const INFRA = /^(GITHUB_|RUNNER_|CI$|HOME$|PATH$|USERPROFILE$|NODE_|MOCK_|TEST_|FORCE_COLOR$|NO_COLOR$|TERM$|APPDATA$|LOCALAPPDATA$|TMP|TEMP|PWD$|SHELL$|USER$|LANG|OS$|COMSPEC$|SYSTEMROOT$)/;

function codeFiles() {
  return fs.readdirSync(ROOT).filter((f) => f.endsWith(".mjs") && fs.statSync(path.join(ROOT, f)).isFile());
}

export function settingsReadByCode() {
  const found = new Map(); // name -> first file
  const add = (n, f) => { if (!INFRA.test(n) && !found.has(n)) found.set(n, f); };
  for (const f of codeFiles()) {
    const s = fs.readFileSync(path.join(ROOT, f), "utf8");
    for (const m of s.matchAll(/process\.env\.([A-Z][A-Z0-9_]{2,})/g)) add(m[1], f);
    for (const m of s.matchAll(/process\.env\[\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) add(m[1], f);
    for (const m of s.matchAll(/\benv[A-Za-z]*\(\s*["']([A-Z][A-Z0-9_]{2,})["']/g)) add(m[1], f);
    for (const m of s.matchAll(/\benv\.([A-Z][A-Z0-9_]{2,})/g)) add(m[1], f);
  }
  return found;
}

const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
const documented = (name) => new RegExp(`\\b${name}\\b`).test(example);

test("the scan finds the settings (a guard against this test silently checking nothing)", () => {
  const s = settingsReadByCode();
  assert.ok(s.size >= 60, `only found ${s.size} settings`);
  for (const must of ["NEWS_MAX_PER_DAY", "ALERT_LEVEL_MARGIN_PCT", "DAILY_CTA", "RESEARCH_DATA_DAY", "GROQ_API_KEY"]) assert.ok(s.has(must), must);
});

test("every setting the code reads is documented in .env.example", () => {
  const missing = [...settingsReadByCode()].filter(([n]) => !documented(n)).map(([n, f]) => `${n} (read in ${f})`);
  assert.deepEqual(missing, [], `Add these to .env.example (a commented line is enough):\n  ${missing.join("\n  ")}`);
});

test("documented defaults match the code for the settings that went wrong before", () => {
  // NEWS_MAX_PER_DAY: the stale file said 12, the code says 40.
  const code = fs.readFileSync(path.join(ROOT, "post.mjs"), "utf8");
  const def = /envNum(?:ber)?\(\s*"NEWS_MAX_PER_DAY"\s*,\s*(\d+)\s*\)/.exec(code)?.[1];
  assert.ok(def, "could not find the NEWS_MAX_PER_DAY default in post.mjs");
  const line = example.split("\n").find((l) => /NEWS_MAX_PER_DAY=/.test(l));
  assert.ok(line, "NEWS_MAX_PER_DAY is not documented as NAME=value");
  assert.match(line, new RegExp(`NEWS_MAX_PER_DAY=${def}\\b`), `.env.example says ${line.trim()} but the code default is ${def}`);
});

test(".env.example has no duplicated setting names on active lines", () => {
  const names = example.split("\n").map((l) => /^\s*#?\s*([A-Z][A-Z0-9_]{2,})=/.exec(l)?.[1]).filter(Boolean);
  const dup = names.filter((n, i) => names.indexOf(n) !== i && n !== "ALERT_CHART_HOURS");
  assert.deepEqual([...new Set(dup)], []);
});
