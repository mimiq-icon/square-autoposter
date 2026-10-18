// test/news-sync.test.mjs — the claim lock, tested against REAL git remotes.
// Two clones of one bare repo stand in for "GitHub runner" and "your PC".
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitAvailable, commitPush, pullState, currentBranch } from "../news-sync.mjs";
import { emptyNewsState, recordClaim, normalizeNewsState, isAlreadyPosted, clusterStories } from "../news.mjs";

const g = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let hasGit = true;
try { g(os.tmpdir(), "--version"); } catch { hasGit = false; }

const FILE = "news-state/posted.json";
const story = (title) => clusterStories([{ title, link: `https://x.test/${encodeURIComponent(title)}`, source: "A", summary: "", publishedAt: Date.now() }])[0];
const writeState = (dir, state) => {
  fs.mkdirSync(path.join(dir, "news-state"), { recursive: true });
  fs.writeFileSync(path.join(dir, FILE), JSON.stringify(state, null, 2) + "\n");
};
const readState = (dir) => normalizeNewsState(JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8")));

describe("git claim lock", { skip: !hasGit && "git not installed" }, () => {
  let root, bare, github, pc;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "newssync-"));
    bare = path.join(root, "remote.git");
    g(root, "init", "--bare", "-b", "main", bare);
    const seed = path.join(root, "seed");
    g(root, "clone", bare, seed);
    g(seed, "config", "user.email", "t@t"); g(seed, "config", "user.name", "t");
    fs.writeFileSync(path.join(seed, "README.md"), "x");
    g(seed, "add", "."); g(seed, "commit", "-m", "init"); g(seed, "push", "origin", "HEAD:main");
    github = path.join(root, "github"); pc = path.join(root, "pc");
    g(root, "clone", bare, github); g(root, "clone", bare, pc);
    for (const d of [github, pc]) { g(d, "config", "user.email", "t@t"); g(d, "config", "user.name", "t"); }
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("gitAvailable / currentBranch", () => {
    assert.equal(gitAvailable(pc), true);
    assert.equal(gitAvailable(os.tmpdir()), false);
    assert.equal(currentBranch(pc), "main");
  });

  test("pullState reports a missing remote file without error", () => {
    const r = pullState(pc, FILE);
    assert.equal(r.result, "missing");
    assert.match(r.tip, /^[0-9a-f]{40}$/);
  });

  test("first claim pushes; the other machine sees it after a pull", () => {
    const base = pullState(github, FILE);
    assert.equal(base.result, "missing");
    writeState(github, recordClaim(emptyNewsState(), story("SEC approves Solana ETF"), Date.now()));
    const r = commitPush(github, FILE, "claim A", { baseTip: base.tip });
    assert.equal(r.result, "pushed");
    const p = pullState(pc, FILE);
    assert.equal(p.result, "updated");
    assert.equal(p.tip, r.tip);
    assert.ok(isAlreadyPosted(story("SEC approves Solana ETF"), readState(pc)));
  });

  test("RACE: both machines claim the same story from the same view; exactly one wins", () => {
    const g0 = pullState(github, FILE);   // both start from the same tip
    const p0 = pullState(pc, FILE);
    assert.equal(g0.tip, p0.tip);

    writeState(github, recordClaim(readState(github), story("Fed holds rates steady"), Date.now()));
    writeState(pc, recordClaim(readState(pc), story("Fed holds rates steady"), Date.now()));

    const first = commitPush(github, FILE, "github claims Fed story", { baseTip: g0.tip });
    const second = commitPush(pc, FILE, "pc claims Fed story", { baseTip: p0.tip });
    assert.equal(first.result, "pushed");
    assert.equal(second.result, "conflict", "the loser must be rejected, not silently merged");

    // The loser re-reads, sees the winner's claim, and stands down.
    const re = pullState(pc, FILE);
    assert.equal(re.result, "updated");
    assert.ok(isAlreadyPosted(story("Fed holds rates steady"), readState(pc)));
    const titles = JSON.parse(g(bare, "show", "main:" + FILE)).posted.map((x) => x.title);
    assert.deepEqual(titles.filter((t) => t === "Fed holds rates steady").length, 1, "claimed exactly once");
    assert.ok(titles.includes("SEC approves Solana ETF"), "earlier claims survive");
  });

  test("a stale writer can NOT overwrite a claim it has never seen (no lost update)", () => {
    const stale = pullState(pc, FILE);                       // pc's view: tip T
    writeState(github, recordClaim(readState(github), story("Binance lists new token"), Date.now()));
    const gh = pullState(github, FILE);                      // github catches up, then claims a NEW story
    writeState(github, recordClaim(readState(github), story("Binance lists new token"), Date.now()));
    assert.equal(commitPush(github, FILE, "claim C", { baseTip: gh.tip }).result, "pushed");

    // pc, still on tip T, claims a DIFFERENT story. Its file lacks claim C.
    writeState(pc, recordClaim(readState(pc), story("Coinbase adds a token today"), Date.now()));
    assert.equal(commitPush(pc, FILE, "claim D", { baseTip: stale.tip }).result, "conflict");

    // The authoritative remote (the bare repo) still has C, and not yet D.
    const titles = JSON.parse(g(bare, "show", "main:" + FILE)).posted.map((x) => x.title);
    assert.ok(titles.includes("Binance lists new token"), "C must not be overwritten");
    assert.ok(!titles.includes("Coinbase adds a token today"));

    // After re-syncing, pc can claim D cleanly on top of C.
    const re = pullState(pc, FILE);
    writeState(pc, recordClaim(readState(pc), story("Coinbase adds a token today"), Date.now()));
    assert.equal(commitPush(pc, FILE, "claim D", { baseTip: re.tip }).result, "pushed");
    const after = JSON.parse(g(bare, "show", "main:" + FILE)).posted.map((x) => x.title);
    assert.ok(after.includes("Binance lists new token") && after.includes("Coinbase adds a token today"));
  });

  test("commitPush refuses to run without a baseTip", () => {
    assert.equal(commitPush(pc, FILE, "x").result, "error");
  });

  test("the lock never touches the working tree, branch or other files", () => {
    fs.writeFileSync(path.join(pc, "local-notes.txt"), "uncommitted work");
    fs.writeFileSync(path.join(pc, ".env"), "SECRET=1");
    const head = g(pc, "rev-parse", "HEAD");
    const base = pullState(pc, FILE);
    writeState(pc, recordClaim(readState(pc), story("Another story entirely here"), Date.now()));
    assert.equal(commitPush(pc, FILE, "claim E", { baseTip: base.tip }).result, "pushed");
    assert.equal(g(pc, "rev-parse", "HEAD"), head, "local HEAD must not move");
    assert.equal(fs.readFileSync(path.join(pc, "local-notes.txt"), "utf8"), "uncommitted work");
    const tracked = g(pc, "ls-tree", "-r", "--name-only", "origin/main").split("\n");
    assert.ok(!tracked.includes(".env") && !tracked.includes("local-notes.txt"), "only the state file may be pushed");
  });

  test("an unchanged state file produces no empty commit", () => {
    const base = pullState(pc, FILE);
    assert.equal(commitPush(pc, FILE, "noop", { baseTip: base.tip }).result, "nochange");
  });
});
