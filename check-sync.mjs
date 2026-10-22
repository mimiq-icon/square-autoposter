#!/usr/bin/env node
// check-sync.mjs  (v11.3)
// ============================================================================
// "Is the code on this PC the same as GitHub's?"  One command, plain answer:
//     node check-sync.mjs
// It fetches origin/main and compares CODE (not the bot's own state files:
// news-state/, research-state/, logs/ change all day and are shared through
// git by design, so they are ignored here).
//   up-to-date : this folder's code is identical to GitHub's main
//   behind     : GitHub has newer commits you don't have  -> fix command shown
//   ahead      : you have commits GitHub doesn't
//   diverged   : both of the above
//   modified   : same commit, but files were edited/added/deleted locally
//   error      : not a git clone, or GitHub could not be reached
// Exit code 0 only for "up-to-date".
// ============================================================================
import { execFileSync } from "child_process";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const IGNORED_DIRS = ["news-state", "research-state", "logs", ".cache", "previews"];

function defaultGit(cwd, args, timeoutMs = 30_000) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: timeoutMs, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function checkSync({ cwd = HERE, remote = "origin", branch = "main", fetch = true, git = defaultGit } = {}) {
  const out = { state: "error", localSha: null, remoteSha: null, ahead: 0, behind: 0, changed: [], untracked: [], message: "" };
  const g = (...a) => git(cwd, a);
  try {
    if (g("rev-parse", "--is-inside-work-tree") !== "true") throw new Error("not a git repository");
  } catch {
    out.message = "This folder is not a git clone (it was probably unzipped). Clone the repo instead; see PC-SETUP.md.";
    return out;
  }
  if (fetch) {
    try { g("fetch", "--quiet", remote, branch); } catch (e) {
      out.message = `Could not reach GitHub to compare (${String(e.stderr || e.message).split("\n")[0].trim() || "fetch failed"}). Check the internet connection and run again.`;
      return out;
    }
  }
  const ref = `${remote}/${branch}`;
  try {
    out.localSha = g("rev-parse", "HEAD");
    out.remoteSha = g("rev-parse", ref);
    const [ahead, behind] = g("rev-list", "--left-right", "--count", `HEAD...${ref}`).split(/\s+/).map(Number);
    out.ahead = ahead || 0; out.behind = behind || 0;
    const excludes = IGNORED_DIRS.map((d) => `:(exclude)${d}`);
    const diff = g("diff", "--name-status", ref, "--", ".", ...excludes);
    out.changed = diff ? diff.split("\n").map((l) => { const [s, ...f] = l.split("\t"); return { status: s, file: f.join("\t") }; }) : [];
    const porcelain = g("status", "--porcelain", "--untracked-files=normal");
    out.untracked = porcelain.split("\n").filter((l) => l.startsWith("?? ")).map((l) => l.slice(3).replace(/^"|"$/g, ""))
      .filter((f) => !IGNORED_DIRS.some((d) => f === d || f.startsWith(d + "/")));
  } catch (e) {
    out.message = `Could not compare with ${ref} (${String(e.stderr || e.message).split("\n")[0].trim()}).`;
    return out;
  }
  const dirty = out.changed.length > 0 || out.untracked.length > 0;
  if (out.behind && out.ahead) out.state = "diverged";
  else if (out.behind) out.state = "behind";
  else if (out.ahead) out.state = "ahead";
  else out.state = dirty ? "modified" : "up-to-date";
  // "behind" with identical files can't happen; "ahead" with no file difference is harmless but reported.
  out.message = {
    "up-to-date": `Up to date: this folder's code is identical to GitHub ${ref} (${out.remoteSha.slice(0, 7)}).`,
    behind: `BEHIND: GitHub ${ref} has ${out.behind} newer commit${out.behind === 1 ? "" : "s"} (${out.remoteSha.slice(0, 7)}).`,
    ahead: `AHEAD: this folder has ${out.ahead} commit${out.ahead === 1 ? "" : "s"} GitHub doesn't have.`,
    diverged: `DIVERGED: ${out.ahead} commit(s) here that GitHub lacks, and ${out.behind} on GitHub that you lack.`,
    modified: `MODIFIED: same commit as GitHub (${out.remoteSha.slice(0, 7)}), but code files differ from it.`,
  }[out.state];
  return out;
}

export function formatSync(r) {
  const lines = [r.message];
  const shown = (arr, label) => { if (arr.length) { lines.push(label); for (const x of arr.slice(0, 25)) lines.push(`    ${x}`); if (arr.length > 25) lines.push(`    ... and ${arr.length - 25} more`); } };
  // `git diff origin/main` compares the working tree TO GitHub: M = differs, D = GitHub has it and it is missing here.
  const label = { M: "differs from GitHub", D: "missing here (GitHub has it)", A: "added here (GitHub doesn't have it)", R: "renamed", T: "type changed" };
  shown(r.changed.map((c) => `${label[c.status[0]] || c.status}: ${c.file}`), "  Files that differ from GitHub:");
  shown(r.untracked, "  New files here that GitHub doesn't have:");
  if (["behind", "diverged", "modified"].includes(r.state)) {
    lines.push("  To make this folder identical to GitHub (discards local edits to code files; the .env file is NOT touched):");
    lines.push("      git fetch origin");
    lines.push("      git reset --hard origin/main");
  }
  if (r.state === "ahead") lines.push("  To publish them:  git push   (or ignore: the bot's own state files are handled automatically)");
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const r = checkSync({ fetch: !process.argv.includes("--no-fetch") });
  for (const l of formatSync(r)) console.log(l);
  process.exit(r.state === "up-to-date" ? 0 : 1);
}
