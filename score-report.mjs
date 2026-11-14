#!/usr/bin/env node
// score-report.mjs  (v11.12)
//
// Reads scorecard.csv (the rows you add with score-post.bat) and says, per
// format, what actually earned views and likes. It also settles one question
// with evidence instead of belief: does ending market posts on a question
// ("Which one are you watching?") earn more reach than ending on a fact?
//
//   node score-report.mjs                          summary by format
//   node score-report.mjs --alt-since 2026-11-20   also compare ask vs no-ask
//
// The comparison only means something if DAILY_CTA=alternate was set (a repo
// variable on GitHub, or in .env) from the date you pass. In that mode the bot
// asks on even UTC days and not on odd ones, so each row's arm is known from
// its date alone. It is a rough check, not proof: topics differ day to day, so
// it uses medians and refuses to conclude on a small sample.

import fs from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { ctaAsksOnDay, utcDayNumber } from "./post.mjs";

export const MIN_PER_ARM = 8;
const MARKET_FORMATS = /^(daily|alert)$/i; // the formats the closing question is appended to

// RFC 4180 CSV: quoted fields, commas and newlines inside quotes, "" escapes.
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  const s = String(text ?? "").replace(/^\uFEFF/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((x) => x !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((x) => x !== "")) rows.push(row);
  return rows;
}

const num = (v) => {
  const t = String(v ?? "").trim().replace(/,/g, "");
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

// -> [{ date, format, title, views, likes, comments, follows, notes }], header-driven.
export function parseScorecard(text) {
  const [header, ...body] = parseCsv(text);
  if (!header) return [];
  const idx = Object.fromEntries(header.map((h, i) => [h.trim().toLowerCase(), i]));
  if (idx.format == null) return [];
  const get = (r, k) => (idx[k] == null ? "" : r[idx[k]] ?? "");
  return body
    .map((r) => ({
      date: get(r, "date").trim(), format: get(r, "format").trim().toLowerCase(), title: get(r, "title").trim(),
      views: num(get(r, "views")), likes: num(get(r, "likes")), comments: num(get(r, "comments")), follows: num(get(r, "follows")),
      notes: get(r, "notes").trim(),
    }))
    .filter((r) => r.format);
}

export function median(values) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}
const mean = (values) => { const v = values.filter((x) => Number.isFinite(x)); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

export function summarizeByFormat(rows) {
  const groups = new Map();
  for (const r of rows) { if (r.views == null) continue; (groups.get(r.format) ?? groups.set(r.format, []).get(r.format)).push(r); }
  return [...groups.entries()]
    .map(([format, rs]) => ({
      format, n: rs.length, medianViews: median(rs.map((r) => r.views)), meanViews: mean(rs.map((r) => r.views)),
      medianLikes: median(rs.map((r) => r.likes)), totalFollows: rs.reduce((s, r) => s + (r.follows || 0), 0),
    }))
    .sort((a, b) => b.medianViews - a.medianViews);
}

// ISO date -> UTC day number (the same day boundary the bot uses), or null.
export function dayNumberOfIso(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || "").trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  // reject overflow ('2026-13-01' rolls into January, '2026-02-31' into March): month AND day must survive the round trip
  return Number.isFinite(ms) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? utcDayNumber(ms) : null;
}

export function ctaComparison(rows, { since } = {}) {
  const sinceDay = dayNumberOfIso(since);
  if (sinceDay == null) return { error: "pass --alt-since YYYY-MM-DD (the first date DAILY_CTA=alternate was in force)" };
  const arms = { ask: [], noAsk: [] };
  let skipped = 0;
  for (const r of rows) {
    if (!MARKET_FORMATS.test(r.format) || r.views == null) continue;
    const day = dayNumberOfIso(r.date);
    if (day == null) { skipped++; continue; }
    if (day < sinceDay) continue;
    (ctaAsksOnDay(day) ? arms.ask : arms.noAsk).push(r);
  }
  const stat = (rs) => ({ n: rs.length, medianViews: median(rs.map((r) => r.views)), medianLikes: median(rs.map((r) => r.likes)), follows: rs.reduce((s, r) => s + (r.follows || 0), 0) });
  const ask = stat(arms.ask), noAsk = stat(arms.noAsk);
  let verdict, enough = ask.n >= MIN_PER_ARM && noAsk.n >= MIN_PER_ARM;
  if (!enough) verdict = `Too few posts to conclude: need at least ${MIN_PER_ARM} per arm, have ${ask.n} that asked and ${noAsk.n} that did not. Keep logging.`;
  else {
    const ratio = noAsk.medianViews > 0 ? ask.medianViews / noAsk.medianViews : Infinity;
    if (ratio >= 1.3) verdict = `Posts that ask got ${Math.round((ratio - 1) * 100)}% more views at the median. Keep the question, and check likes and follows, which it may not move.`;
    else if (ratio <= 0.77) verdict = `Posts that ask got ${Math.round((1 - ratio) * 100)}% fewer views at the median. Turn the question off (DAILY_CTA=off).`;
    else verdict = "No clear difference (the two medians are within about 30% of each other), which at this size is noise. The question is not earning reach, so ending on a fact costs nothing; consider DAILY_CTA=off.";
  }
  return { ask, noAsk, skipped, enough, verdict };
}

export function formatReport(rows, { since } = {}) {
  const out = [];
  const withViews = rows.filter((r) => r.views != null);
  out.push(`Scorecard: ${rows.length} rows, ${withViews.length} with views.`, "");
  if (!withViews.length) { out.push("Nothing to summarise yet. Add rows with score-post.bat."); return out.join("\n"); }
  out.push("By format (median views, median likes, follows gained):");
  for (const s of summarizeByFormat(rows)) {
    out.push(`  ${s.format.padEnd(10)} n=${String(s.n).padEnd(3)} median views ${String(Math.round(s.medianViews)).padEnd(6)} likes ${s.medianLikes == null ? "-" : s.medianLikes}  follows ${s.totalFollows}${s.n < 5 ? "   (few posts: treat as a hint)" : ""}`);
  }
  out.push("");
  if (since) {
    const c = ctaComparison(rows, { since });
    if (c.error) out.push(`Closing question test: ${c.error}`);
    else {
      out.push(`Closing question test (daily posts and alerts since ${since}):`);
      out.push(`  asked a question:    n=${c.ask.n}   median views ${c.ask.medianViews ?? "-"}   likes ${c.ask.medianLikes ?? "-"}   follows ${c.ask.follows}`);
      out.push(`  ended on a fact:     n=${c.noAsk.n}   median views ${c.noAsk.medianViews ?? "-"}   likes ${c.noAsk.medianLikes ?? "-"}   follows ${c.noAsk.follows}`);
      out.push(`  ${c.verdict}`);
      if (c.skipped) out.push(`  (${c.skipped} rows skipped: the date was not YYYY-MM-DD)`);
      out.push("  Caution: topics differ day to day. A big move gets views with or without a question.");
    }
  } else {
    out.push("Closing question test: set DAILY_CTA=alternate (a repo variable on GitHub, or in .env) and re-run with --alt-since YYYY-MM-DD, the first date it was in force.");
  }
  return out.join("\n");
}

function main(argv) {
  const get = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
  const file = get("--file") || path.join(path.dirname(fileURLToPath(import.meta.url)), "scorecard.csv");
  if (!fs.existsSync(file)) { console.error(`No scorecard at ${file}. Add a row with score-post.bat first.`); return 1; }
  console.log(formatReport(parseScorecard(fs.readFileSync(file, "utf8")), { since: get("--alt-since") }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(main(process.argv.slice(2)));
