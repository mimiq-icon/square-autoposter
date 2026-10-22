// test/check-sync.test.mjs — v11.3: "is this PC's code the same as GitHub's?" against REAL git repos.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { checkSync, formatSync } from "../check-sync.mjs";

let hasGit = true;
try { execFileSync("git", ["--version"], { stdio: "ignore" }); } catch { hasGit = false; }
const sh = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const id = ["-c", "user.name=t", "-c", "user.email=t@t"];

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sync-"));
  const bare = path.join(root, "remote.git");
  sh(root, "init", "-q", "--bare", "-b", "main", bare);
  const a = path.join(root, "pc"), b = path.join(root, "other");
  sh(root, "clone", "-q", bare, a);
  fs.writeFileSync(path.join(a, "post.mjs"), "// v1\n");
  fs.mkdirSync(path.join(a, "news-state"));
  fs.writeFileSync(path.join(a, "news-state", "posted.json"), "{}\n");
  sh(a, ...id, "add", "-A"); sh(a, ...id, "commit", "-q", "-m", "seed"); sh(a, "branch", "-M", "main"); sh(a, "push", "-q", "-u", "origin", "main");
  sh(root, "clone", "-q", bare, b);
  return { root, bare, a, b };
}
const pushFrom = (dir, file, text) => { fs.writeFileSync(path.join(dir, file), text); sh(dir, ...id, "add", "-A"); sh(dir, ...id, "commit", "-q", "-m", "change " + file); sh(dir, "push", "-q", "origin", "main"); };

test("check-sync: identical => up-to-date, exit-worthy", { skip: !hasGit }, () => {
  const w = world();
  const r = checkSync({ cwd: w.a });
  assert.equal(r.state, "up-to-date"); assert.match(r.message, /identical to GitHub origin\/main/);
});

test("check-sync: the bot's own state files changing does NOT count as out of date", { skip: !hasGit }, () => {
  const w = world();
  fs.writeFileSync(path.join(w.a, "news-state", "posted.json"), '{"posted":[1]}\n');
  fs.mkdirSync(path.join(w.a, "logs")); fs.writeFileSync(path.join(w.a, "logs", "news.log"), "x");
  assert.equal(checkSync({ cwd: w.a }).state, "up-to-date");
});

test("check-sync: GitHub has a newer commit => behind, with the fix command and the changed file named", { skip: !hasGit }, () => {
  const w = world();
  pushFrom(w.b, "post.mjs", "// v2\n");
  const r = checkSync({ cwd: w.a });
  assert.equal(r.state, "behind"); assert.equal(r.behind, 1);
  assert.deepEqual(r.changed.map((c) => c.file), ["post.mjs"]);
  const text = formatSync(r).join("\n");
  assert.match(text, /BEHIND/); assert.match(text, /post\.mjs/); assert.match(text, /git reset --hard origin\/main/);
});

test("check-sync: a locally edited code file, or a new file, is 'modified'", { skip: !hasGit }, () => {
  let w = world();
  fs.writeFileSync(path.join(w.a, "post.mjs"), "// edited here\n");
  let r = checkSync({ cwd: w.a });
  assert.equal(r.state, "modified"); assert.match(formatSync(r).join("\n"), /differs from GitHub: post\.mjs/);
  w = world();
  fs.writeFileSync(path.join(w.a, "stray.mjs"), "x");
  r = checkSync({ cwd: w.a });
  assert.equal(r.state, "modified"); assert.deepEqual(r.untracked, ["stray.mjs"]);
});

test("check-sync: a file GitHub has but this folder lost is reported", { skip: !hasGit }, () => {
  const w = world();
  fs.rmSync(path.join(w.a, "post.mjs"));
  const r = checkSync({ cwd: w.a });
  assert.equal(r.state, "modified"); assert.match(formatSync(r).join("\n"), /missing here \(GitHub has it\): post\.mjs/);
});

test("check-sync: local commit GitHub lacks => ahead; both => diverged", { skip: !hasGit }, () => {
  const w = world();
  pushFrom(w.b, "post.mjs", "// other\n");
  fs.writeFileSync(path.join(w.a, "local.mjs"), "x"); sh(w.a, ...id, "add", "-A"); sh(w.a, ...id, "commit", "-q", "-m", "local");
  assert.equal(checkSync({ cwd: w.a }).state, "diverged");
  const w2 = world();
  fs.writeFileSync(path.join(w2.a, "local.mjs"), "x"); sh(w2.a, ...id, "add", "-A"); sh(w2.a, ...id, "commit", "-q", "-m", "local");
  assert.equal(checkSync({ cwd: w2.a }).state, "ahead");
});

test("check-sync: after the suggested fix it reports up-to-date", { skip: !hasGit }, () => {
  const w = world();
  pushFrom(w.b, "post.mjs", "// v2\n");
  fs.writeFileSync(path.join(w.a, "post.mjs"), "// junk\n");
  sh(w.a, "fetch", "origin"); sh(w.a, "reset", "--hard", "origin/main");
  assert.equal(checkSync({ cwd: w.a }).state, "up-to-date");
});

test("check-sync: not a git clone, and GitHub unreachable, give plain errors", { skip: !hasGit }, () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
  const r1 = checkSync({ cwd: plain });
  assert.equal(r1.state, "error"); assert.match(r1.message, /not a git clone/);
  const w = world();
  sh(w.a, "remote", "set-url", "origin", path.join(w.root, "does-not-exist.git"));
  const r2 = checkSync({ cwd: w.a });
  assert.equal(r2.state, "error"); assert.match(r2.message, /Could not reach GitHub/);
});
