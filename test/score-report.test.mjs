import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseCsv, parseScorecard, median, summarizeByFormat, dayNumberOfIso, ctaComparison, formatReport, MIN_PER_ARM,
} from "../score-report.mjs";
import { resolveDailyCta, ctaAsksOnDay, utcDayNumber, appendCta } from "../post.mjs";

const HEADER = "date,format,title,views,likes,comments,follows,notes";
const iso = (day) => new Date(day * 86_400_000).toISOString().slice(0, 10);
const D0 = dayNumberOfIso("2026-11-02"); // a fixed anchor; parity is read from the bot's own rule, never hard-coded
// n consecutive days starting at D0, as scorecard rows: the arm follows ctaAsksOnDay.
const rows = (n, viewsAsk, viewsNo, format = "daily") => Array.from({ length: n }, (_, i) => {
  const day = D0 + i;
  return { date: iso(day), format, title: `p${i}`, views: ctaAsksOnDay(day) ? viewsAsk : viewsNo, likes: 1, comments: 0, follows: 0, notes: "" };
});

describe("parseCsv: RFC 4180", () => {
  test("plain rows and a header", () => assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]));
  test("quoted commas, escaped quotes and a newline inside a field", () => {
    assert.deepEqual(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n'), [["a", "b"], ["x, y", 'say "hi"\nthere']]);
  });
  test("CRLF line endings, blank lines, a BOM", () => assert.deepEqual(parseCsv("\uFEFFa,b\r\n\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]));
  test("a final row with no trailing newline", () => assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]));
  test("empty input", () => assert.deepEqual(parseCsv(""), []));
});

describe("parseScorecard", () => {
  test("reads the score-post.ps1 columns, coerces numbers, lowercases the format", () => {
    const r = parseScorecard(`${HEADER}\n2026-11-02,Daily,"$ARB, -13%",915,2,"1",0,"asked, ""read"""\n`);
    assert.deepEqual(r, [{ date: "2026-11-02", format: "daily", title: "$ARB, -13%", views: 915, likes: 2, comments: 1, follows: 0, notes: 'asked, "read"' }]);
  });
  test("blank or junk numbers become null, thousands separators are tolerated", () => {
    const [r] = parseScorecard(`${HEADER}\n2026-11-02,news,t,"1,204",,x,,\n`);
    assert.deepEqual({ v: r.views, l: r.likes, c: r.comments }, { v: 1204, l: null, c: null });
  });
  test("header-driven: column order does not matter; no format column means nothing", () => {
    assert.equal(parseScorecard("format,views,date\nnews,10,2026-11-02\n")[0].views, 10);
    assert.deepEqual(parseScorecard("a,b\n1,2\n"), []);
  });
  test("a header-only file (the file as shipped) is empty, not an error", () => assert.deepEqual(parseScorecard(`${HEADER}\n`), []));
});

describe("median and the format summary", () => {
  test("median: odd, even, ignores non-numbers, empty is null", () => {
    assert.equal(median([3, 1, 2]), 2); assert.equal(median([4, 1, 2, 3]), 2.5); assert.equal(median([1, NaN, null, 9].filter(() => true)), 5); assert.equal(median([]), null);
  });
  test("summarizeByFormat sorts by median views and skips rows with no views", () => {
    const s = summarizeByFormat([
      { format: "news", views: 150, likes: 2, follows: 1 }, { format: "news", views: 107, likes: 0, follows: 0 }, { format: "news", views: 759, likes: 2, follows: 0 },
      { format: "daily", views: 915, likes: 0, follows: 0 }, { format: "daily", views: null, likes: 5, follows: 9 },
    ]);
    assert.deepEqual(s.map((x) => [x.format, x.n, x.medianViews]), [["daily", 1, 915], ["news", 3, 150]]);
    assert.equal(s.find((x) => x.format === "news").totalFollows, 1);
  });
});

describe("dayNumberOfIso", () => {
  test("matches the bot's own day numbering", () => assert.equal(dayNumberOfIso("2026-11-02"), utcDayNumber(Date.UTC(2026, 10, 2, 8, 30))));
  test("rejects anything that is not a real YYYY-MM-DD", () => { for (const v of ["", "2/11/2026", "2026-13-01", "2026-00-10", "2026-02-31", "2026-04-31", null, "tomorrow"]) assert.equal(dayNumberOfIso(v), null, String(v)); });
});

describe("DAILY_CTA=alternate (the bot side)", () => {
  const T = Date.UTC(2026, 10, 2, 8, 30);
  test("asks on one day and not the next, and the two are always opposite", () => {
    for (let i = 0; i < 6; i++) assert.notEqual(resolveDailyCta("alternate", T + i * 86_400_000), resolveDailyCta("alternate", T + (i + 1) * 86_400_000));
  });
  test("the same UTC day always gives the same answer, whatever the hour", () => {
    assert.equal(resolveDailyCta("alternate", Date.UTC(2026, 10, 2, 0, 0, 1)), resolveDailyCta("alternate", Date.UTC(2026, 10, 2, 23, 59, 59)));
  });
  test("aliases, and the old settings are unchanged", () => {
    assert.equal(resolveDailyCta("alt", T), resolveDailyCta("alternate", T)); assert.equal(resolveDailyCta("ab", T), resolveDailyCta("alternate", T));
    for (const v of [undefined, "", "on", "yes", "1"]) assert.equal(resolveDailyCta(v, T), true, String(v));
    for (const v of ["off", "none", "false", "no", "0", "OFF"]) assert.equal(resolveDailyCta(v, T), false, String(v));
  });
  test("on an 'asks' day the question is appended; on the other day the text is untouched", () => {
    const body = "$BTC is at $82,700.\n\nNot financial advice.";
    const askDay = T + (ctaAsksOnDay(utcDayNumber(T)) ? 0 : 86_400_000);
    const noAskDay = askDay + 86_400_000;
    assert.match(appendCta(body, { enabled: resolveDailyCta("alternate", askDay) }), /What's your read on \$BTC today\?/);
    assert.equal(appendCta(body, { enabled: resolveDailyCta("alternate", noAskDay) }), body);
  });
});

describe("ctaComparison: which arm a row is in comes from its date alone", () => {
  test("rows are split by the bot's parity rule, and only daily and alert rows count", () => {
    const rs = [...rows(16, 400, 200), ...rows(16, 9999, 9999, "news"), ...rows(4, 1, 1, "explainer")];
    const c = ctaComparison(rs, { since: iso(D0) });
    assert.equal(c.ask.n + c.noAsk.n, 16);
    assert.equal(c.ask.medianViews, 400); assert.equal(c.noAsk.medianViews, 200);
  });
  test("rows before --alt-since, with no views, or with a bad date are left out", () => {
    const rs = [...rows(16, 400, 200), { date: "garbage", format: "daily", views: 5 }, { date: iso(D0 + 1), format: "daily", views: null }];
    const c = ctaComparison(rs, { since: iso(D0 + 8) });
    assert.equal(c.ask.n + c.noAsk.n, 8);
    assert.equal(c.skipped, 1);
  });
  test("alerts and daily posts both feed the comparison", () => {
    const c = ctaComparison([...rows(8, 300, 100, "daily"), ...rows(8, 300, 100, "alert")], { since: iso(D0) });
    assert.equal(c.ask.n + c.noAsk.n, 16);
  });
  test("needs a valid --alt-since", () => {
    assert.match(ctaComparison(rows(4, 1, 1), {}).error, /--alt-since/);
    assert.match(ctaComparison(rows(4, 1, 1), { since: "nope" }).error, /--alt-since/);
  });

  describe("verdicts", () => {
    const run = (viewsAsk, viewsNo, n = 24) => ctaComparison(rows(n, viewsAsk, viewsNo), { since: iso(D0) });
    test(`refuses to conclude under ${MIN_PER_ARM} per arm`, () => {
      const c = run(900, 100, 10); assert.equal(c.enough, false); assert.match(c.verdict, /^Too few posts to conclude/);
    });
    test("asking clearly wins: keep it, but check likes and follows", () => {
      const c = run(500, 200); assert.equal(c.enough, true); assert.match(c.verdict, /150% more views[^.]*\. Keep the question/);
    });
    test("asking clearly loses: turn it off", () => assert.match(run(100, 300).verdict, /67% fewer views[^.]*\. Turn the question off/));
    test("a gap inside about 30% is called noise, and says ending on a fact costs nothing", () => {
      assert.match(run(220, 200).verdict, /^No clear difference/);
      assert.match(run(160, 200).verdict, /^No clear difference/);
    });
    test("boundaries: exactly +30% is a win, exactly -23% is a loss", () => {
      assert.match(run(260, 200).verdict, /30% more views/);
      assert.match(run(154, 200).verdict, /fewer views/);
    });
    test("a zero-view no-ask arm does not divide by zero", () => assert.match(run(50, 0).verdict, /more views/));
  });
});

describe("formatReport", () => {
  test("empty scorecard", () => assert.match(formatReport([]), /Nothing to summarise yet/));
  test("without --alt-since it explains how to start the test", () => {
    const t = formatReport(rows(6, 10, 10));
    assert.match(t, /By format/); assert.match(t, /DAILY_CTA=alternate/); assert.doesNotMatch(t, /asked a question/);
  });
  test("with --alt-since it prints both arms, a verdict and the caution", () => {
    const t = formatReport(rows(24, 500, 200), { since: iso(D0) });
    assert.match(t, /asked a question: +n=12/); assert.match(t, /ended on a fact: +n=12/); assert.match(t, /Keep the question/); assert.match(t, /Caution: topics differ/);
  });
  test("few posts in a format are flagged as a hint", () => assert.match(formatReport(rows(3, 10, 10)), /few posts: treat as a hint/));
});
