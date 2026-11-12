// style.mjs  (v11.5)
//
// One place that defines what "machine-written" sounds like, and rejects it.
// Every writer (news, alerts, daily, research, weekly article) puts
// STYLE_GUIDE in its prompt and runs lintStyle() on what comes back. A failed
// lint is a retryable failure: the model gets the reason and tries again, and
// after that the plain template is used. Nothing here checks facts (that is
// the grounding validators' job); it only checks voice.
//
// Kinds:
//   "short"    news, alerts, daily posts. No question marks, no dashes.
//   "research" education/research posts. No question marks, at most one dash.
//   "long"     weekly article. A mid-text question is fine, a closing one is
//              not; a few dashes are tolerated.

// What we want, in the model's own terms. Appended to each writer's prompt.
export const STYLE_GUIDE = [
  "VOICE: write like a wire-service reporter, not an assistant. Plain, specific, declarative.",
  "- State what happened and the number. One idea per sentence. Short words.",
  "- No questions anywhere, and never end on a question. No calls to action.",
  "- No 'not just X but Y' or 'more than just' constructions.",
  "- No dashes used as a flourish (— or –). Use a full stop or a comma.",
  "- No scene-setting openers ('Ever wonder', 'Imagine', 'In today's market', \"Let's dive in\").",
  "- No filler or buzzwords: spotlight, landscape, game-changer, testament, underscores, sheds light, delve, navigate, stay tuned, keep an eye on, worth watching, remains to be seen.",
  "- Do not describe the mood of the market. Report figures and who said what.",
];

const SHORT = "short";
const RESEARCH = "research";
const LONG = "long";

const RULES = [
  {
    id: "opener",
    re: /^\s*(?:[^\w\s]{0,3}\s*)?(ever wonder|have you ever|what if|imagine|picture this|let'?s (?:dive|explore|break|unpack|take a look|look at)|here'?s (?:the thing|why|what|how)|in (?:today'?s|the world of|a world)|did you know|think about it)\b/i,
    why: "opens with a scene-setting hook",
  },
  {
    id: "not-just",
    re: /\bnot (?:just|only|merely|simply)\b|\b(?:isn'?t|aren'?t|wasn'?t|weren'?t|doesn'?t|don'?t|didn'?t) (?:just|only|merely|simply)\b|\bmore than (?:just|merely|simply)\b|\bnot so much\b[^.?!]{0,60}\bas\b/i,
    why: "uses a 'not just X but Y' construction",
  },
  {
    id: "reveal",
    re: /\b(?:the (?:result|catch|twist|kicker|takeaway|bottom line|verdict)\?|here'?s the (?:thing|catch|kicker|rub)|bottom line:|the takeaway:|key takeaway:|in short:|in essence|at the end of the day)/i,
    why: "uses a rhetorical reveal",
  },
  {
    id: "filler",
    re: /\b(spotlight|delve|delving|tapestry|landscape|game[- ]?changer|testament|underscores?|underscored|sheds? (?:some )?light|ripple effect|roller-?coaster|buckle up|stay tuned|keep(?:ing)? an eye on|worth watching|worth keeping an eye|time will tell|remains to be seen|worth noting|interestingly|importantly|in a significant move|paving the way|stark reminder|navigat(?:e|es|ing) (?:the|a|this)|pivotal|seamless(?:ly)?|vibrant|ever[- ](?:evolving|changing)|double-edged|whether you'?re)\b/i,
    why: "uses a buzzword or filler phrase",
  },
  {
    id: "hype",
    re: /\b(massive|huge|insane|wild|crazy|explosive|bloodbath|carnage|fireworks|mania|euphoria|panic selling|rocket(?:s|ing)?|moonshot|skyrocket(?:s|ed|ing)?)\b/i,
    why: "uses a hype word",
  },
  {
    id: "mood",
    re: /\b(search interest splits|macro staples|smaller names|big names|the usual suspects|taking center stage|center stage|steals the show|stealing the show|in focus|front and center|headline-grabbing|market buzz|buzzing)\b/i,
    why: "describes the market's mood instead of reporting a figure",
  },
];

function snippet(text, re) {
  const m = text.match(re);
  if (!m) return "";
  return m[0].trim().slice(0, 40);
}

function dashCount(text) {
  return (text.match(/[—–]/g) || []).length;
}

// lintStyle(text, { kind }) -> { ok: true } | { ok: false, rule, reason }
// `reason` is written for the model: it is fed back verbatim on a retry.
export function lintStyle(text, { kind = SHORT } = {}) {
  const t = String(text || "").trim();
  if (!t) return { ok: true };
  const fail = (rule, detail) => ({
    ok: false,
    rule,
    reason: `style: ${detail}. Rewrite it as plain wire copy: state the fact and the figure, no flourish.`,
  });

  for (const r of RULES) {
    if (r.re.test(t)) return fail(r.id, `${r.why} ("${snippet(t, r.re)}")`);
  }

  // Questions. A post that asks the reader something is engagement bait; a
  // long article may ask one mid-text but must not end on one.
  const endsWithQuestion = /\?["'”’)\]\s]*$/.test(t);
  if (endsWithQuestion) return fail("closing-question", "ends on a question");
  if ((kind === SHORT || kind === RESEARCH) && t.includes("?")) {
    return fail("question", "asks the reader a question");
  }

  // Dashes as flourish. "Bitcoin — the largest coin — rose" is the tell; a
  // numeric range like 3–5% is not, so a dash between digits is ignored.
  const dashes = dashCount(t.replace(/(\d)\s*[–—-]\s*(\d)/g, "$1-$2"));
  const limit = kind === LONG ? 3 : kind === RESEARCH ? 1 : 0;
  if (dashes > limit) return fail("dash", "uses dashes as a flourish");

  return { ok: true };
}

// Lint a labelled set of lines, e.g. { headline, context, detail }. Returns
// the first failure with the label added, or { ok: true }.
export function lintLines(lines, { kind = SHORT } = {}) {
  for (const [label, text] of Object.entries(lines)) {
    if (!text) continue;
    const r = lintStyle(text, { kind });
    if (!r.ok) return { ...r, reason: `${label} ${r.reason}` };
  }
  return { ok: true };
}
