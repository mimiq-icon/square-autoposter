#!/usr/bin/env node
// run-mode.mjs  (v11.3)
// ============================================================================
// Run ANY part of the bot on the PC, with your .env loaded, as a DRY RUN by
// default (nothing is posted, no state is saved). Examples:
//     node run-mode.mjs news
//     node run-mode.mjs alerts
//     node run-mode.mjs research RESEARCH_MODE=article
//     node run-mode.mjs research RESEARCH_TOPIC=<id>
//     node run-mode.mjs weekly-approve
//     node run-mode.mjs daily
//     node run-mode.mjs digest
//     node run-mode.mjs list          (shows the modes and research topic ids)
// Extra KEY=VALUE arguments become environment variables for that run.
// Add --live to REALLY post (asks no questions; use it deliberately).
// ============================================================================
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { loadEnvFile, buildChildEnv } from "./local-runner.mjs";
import { gitAvailable } from "./news-sync.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const MODES = {
  news: { mode: "news", what: "breaking-news pick, write, card" },
  alerts: { mode: "alerts", what: "price alerts (level cross / big move)" },
  research: { mode: "research", what: "education / research post or monthly article" },
  daily: { mode: "", what: "the daily market post" },
  digest: { mode: "top-movers-digest", what: "top-movers digest" },
  "weekly-approve": { mode: "weekly-approve", what: "AI-written weekly article (Telegram approval)" },
  "weekly-draft": { mode: "weekly-draft", what: "weekly article draft (old issue flow)" },
  "weekly-publish": { mode: "weekly-publish", what: "weekly article publish (old issue flow)" },
};

export function parseArgs(argv) {
  const out = { name: null, live: false, extra: {}, error: null };
  for (const a of argv) {
    if (a === "--live") out.live = true;
    else if (a === "--dry-run") out.live = false;
    else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { const i = a.indexOf("="); out.extra[a.slice(0, i)] = a.slice(i + 1); }
    else if (!out.name) out.name = a;
    else out.error = `Unexpected argument: ${a}`;
  }
  return out;
}

export function buildRunEnv(baseEnv, { name, live, extra, gitOk }) {
  const def = MODES[name];
  const env = buildChildEnv({ ...baseEnv, ...extra }, { dryRun: !live, gitOk, mode: def.mode });
  if (live) { if (String(env.DRY_RUN).toLowerCase() === "true" && !("DRY_RUN" in extra)) delete env.DRY_RUN; }
  else env.DRY_RUN = "true";
  return env;
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv);
  if (!a.name || a.name === "list" || a.name === "help" || a.error) {
    if (a.error) console.log(a.error + "\n");
    console.log("Modes:");
    for (const [k, v] of Object.entries(MODES)) console.log(`  ${k.padEnd(15)} ${v.what}`);
    try {
      const { RESEARCH_TOPICS } = await import("./research.mjs");
      console.log("\nResearch topic ids (use RESEARCH_TOPIC=<id>):");
      for (const t of RESEARCH_TOPICS) console.log(`  ${t.id.padEnd(28)} ${t.kind}`);
    } catch { /* research module optional */ }
    console.log("\nDry run by default. Add --live to really post.");
    return a.name && a.name !== "list" && a.name !== "help" ? 1 : 0;
  }
  if (!MODES[a.name]) { console.log(`Unknown mode "${a.name}". Run: node run-mode.mjs list`); return 1; }
  loadEnvFile(path.join(HERE, ".env"));
  const env = buildRunEnv(process.env, { ...a, gitOk: gitAvailable(HERE) });
  console.log(`>>> ${a.name} (${a.live ? "LIVE: this will really post" : "DRY RUN: nothing is posted or saved"})`);
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, "post.mjs")], { cwd: HERE, env, stdio: "inherit" });
    p.on("close", (code) => resolve(code ?? 1));
    p.on("error", (e) => { console.error(e.message); resolve(1); });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((c) => process.exit(c), (e) => { console.error(e); process.exit(1); });
}
