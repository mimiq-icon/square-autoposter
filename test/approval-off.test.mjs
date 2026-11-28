// test/approval-off.test.mjs (v11.14). The workflows ship with approval taps off,
// and the Comment Digest schedule stays removed. Static checks on the YAML so a
// future copy of an old workflow file cannot quietly turn the taps back on.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const wf = (n) => fs.readFileSync(path.join(ROOT, ".github", "workflows", n), "utf8");
// strip full-line comments so a commented-out example cannot satisfy a check
const live = (s) => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

for (const [file, name] of [
  ["news-post.yml", "NEWS_APPROVAL"],
  ["alert-post.yml", "ALERT_APPROVAL"],
  ["research-post.yml", "RESEARCH_APPROVAL"],
  ["weekly-article-telegram.yml", "WEEKLY_APPROVAL"],
]) {
  test(`${file}: ${name} defaults to off and can be switched back on with a repo variable`, () => {
    assert.ok(
      live(wf(file)).includes(`${name}: \${{ vars.${name} || 'off' }}`),
      `${file} must set ${name} from vars.${name} with 'off' as the default`,
    );
  });
}

test("comment-digest.yml has no schedule (manual run only)", () => {
  const y = live(wf("comment-digest.yml"));
  assert.ok(!/^\s*schedule:/m.test(y), "comment-digest.yml must not have a schedule: block");
  assert.ok(/workflow_dispatch/.test(y), "it must stay runnable by hand");
});
