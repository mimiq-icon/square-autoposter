// news-sync.mjs  (v10.1)
// ============================================================================
// Git-based "claim" lock so the GitHub runner and your PC never post the same
// story. Both read and write news-state/posted.json on the repo's main branch.
//
// How the lock works: before a runner publishes anything it writes a claim to
// the state file and pushes it. Git only accepts a push that builds on the
// current remote tip, so if the other machine claimed something a moment
// earlier, this push is REJECTED ("conflict"). The loser then re-reads the
// state, sees the other claim, and picks again (or stands down). No heartbeat,
// no server — git is the arbiter.
//
// Safety: this module deliberately never touches your working tree, index or
// local branch. It builds a commit on top of origin/<branch> that changes
// exactly one file (using a throwaway index) and pushes that commit. Your
// uncommitted work, .env file and checked-out branch are irrelevant to it.
//
// All git calls use execFileSync with an argv array — no shell, no string
// interpolation of any value.
// ============================================================================
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const GIT_TIMEOUT_MS = 60_000;

function git(cwd, args, { env, input } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...(env || {}) },
    input,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

export function gitAvailable(cwd) {
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    git(cwd, ["remote", "get-url", "origin"]);
    return true;
  } catch {
    return false;
  }
}

export function currentBranch(cwd) {
  if (process.env.NEWS_GIT_BRANCH) return process.env.NEWS_GIT_BRANCH;
  try {
    return git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  } catch {
    return process.env.GITHUB_REF_NAME || "main"; // detached HEAD (some CI setups)
  }
}

// Brings the local state file in line with the remote's copy.
// Returns { result: "updated" | "missing" | "error", tip }.
//   missing = the remote has no state file yet (first ever run)
//   tip     = the remote commit this copy was read from. Pass it back to
//             commitPush() as baseTip: that is what makes the lock work.
export function pullState(cwd, relFile, branch = currentBranch(cwd)) {
  let tip;
  try {
    git(cwd, ["fetch", "--quiet", "origin", branch]);
    tip = git(cwd, ["rev-parse", `origin/${branch}`]);
  } catch (e) {
    return { result: "error", error: firstLine(e) };
  }
  let content;
  try {
    content = git(cwd, ["show", `${tip}:${toPosix(relFile)}`]);
  } catch {
    return { result: "missing", tip };
  }
  const abs = path.join(cwd, relFile);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content + "\n");
  return { result: "updated", tip };
}

// Commits the local state file and pushes it, building on `baseTip` — the
// remote commit that the local copy was read from (see pullState).
//
// Why baseTip matters: if the commit were built on a freshly fetched tip
// instead, a runner holding a slightly stale state file would silently
// overwrite a claim the other machine pushed in the meantime (a lost update,
// i.e. a duplicate post). Building on the tip we actually read means the push
// is rejected as non-fast-forward whenever the remote moved, so the caller
// must pullState() and re-decide with the other machine's claim in view.
//
// Returns { result: "pushed" | "nochange" | "conflict" | "error", tip?, error? }
// where `tip` (on "pushed"/"nochange") is the new base for the next commit.
export function commitPush(cwd, relFile, message, { baseTip, name = "square-autoposter-bot", email = "bot@users.noreply.github.com", branch = currentBranch(cwd) } = {}) {
  if (!baseTip) return { result: "error", error: "commitPush needs the baseTip returned by pullState" };
  const tmpIndex = path.join(os.tmpdir(), `news-index-${process.pid}-${Date.now()}`);
  const env = {
    GIT_INDEX_FILE: tmpIndex,
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
  try {
    const blob = git(cwd, ["hash-object", "-w", relFile]);

    // Skip empty commits.
    try {
      if (git(cwd, ["rev-parse", `${baseTip}:${toPosix(relFile)}`]) === blob) return { result: "nochange", tip: baseTip };
    } catch { /* file not on remote yet */ }

    git(cwd, ["read-tree", baseTip], { env });
    git(cwd, ["update-index", "--add", "--cacheinfo", `100644,${blob},${toPosix(relFile)}`], { env });
    const tree = git(cwd, ["write-tree"], { env });
    const commit = git(cwd, ["commit-tree", tree, "-p", baseTip, "-m", message], { env });

    try {
      git(cwd, ["push", "--quiet", "origin", `${commit}:refs/heads/${branch}`]);
    } catch (e) {
      const msg = String(e.stderr || e.message || "");
      if (/non-fast-forward|fetch first|rejected|stale info/i.test(msg)) return { result: "conflict" };
      return { result: "error", error: firstLine(e) };
    }
    try { git(cwd, ["update-ref", `refs/remotes/origin/${branch}`, commit]); } catch { /* cosmetic */ }
    return { result: "pushed", tip: commit };
  } catch (e) {
    return { result: "error", error: firstLine(e) };
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch { /* already gone */ }
  }
}

const toPosix = (p) => p.split(path.sep).join("/");
const firstLine = (e) => String(e.stderr || e.message || e).split("\n").find(Boolean) || "unknown git error";
