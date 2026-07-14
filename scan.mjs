// scan.mjs — Binance Square scanner (read-only, via binance-square-cli)
// ============================================================================
// Three modes, all using the binance-square-cli tool (QuantProcessing/binance-square-cli)
// to READ Binance Square data that the official OpenAPI doesn't expose.
//
// Modes:
//   SCAN_MODE=trend         Fetch homepage feed, find trending coins, post about them
//   SCAN_MODE=competitor    Fetch posts from tracked creators, open GitHub Issue
//   SCAN_MODE=comments      Fetch comments on YOUR posts, open Issue with AI-suggested replies
//
// ⚠️ ToS RISK: This tool scrapes Binance Square via a headless browser. It's
// read-only (no login, no credentials, no posting through the scraper), but
// it IS unofficial. Risk is bounded to GitHub Actions' IP range, not your
// personal IP. If Binance blocks the scraper, the scan fails gracefully and
// your normal daily posting (via official OpenAPI) is unaffected.
//
// The binance-square-cli tool must be installed at /tmp/bsq (cloned + built
// by the workflow before this script runs).
// ============================================================================

import { execSync } from "child_process";
import fs from "fs";

const BSQ_CLI = "/tmp/bsq/dist/index.js";
const SCAN_MODE = process.env.SCAN_MODE || "trend";

// Creators to track for competitor-scan mode.
// Edit this list to add/remove creators you want to follow.
const TRACKED_CREATORS = [
  { username: "momomomo7171", label: "Creator 1" },
  { username: "Square-Creator-590332761", label: "Creator 2", isUid: true },
  { username: "CryptoPM", label: "Creator 3" },
  { username: "hmnghia0612", label: "Creator 4" },
];

// Your own Square creator ID — needed for comment-digest mode.
// Find it in your Binance Square profile URL (e.g. binance.com/square/123456789).
// Set as SQUARE_CREATOR_ID env var / GitHub secret.
const MY_CREATOR_ID = process.env.SQUARE_CREATOR_ID || "";

// SECURITY: never let the unverified/unpinned binance-square-cli subprocess
// see our real secrets, even though the tool claims to be credential-free.
// execSync inherits the full parent environment by default — that means an
// unpinned `git clone` of someone else's repo would otherwise run with
// BINANCE_SQUARE_OPENAPI_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, and
// SQUARE_CREATOR_ID sitting right there in its process environment. Build an
// explicit allowlist instead of trusting the tool's own claims about what it
// touches.
const SECRET_ENV_KEYS = [
  "BINANCE_SQUARE_OPENAPI_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "SQUARE_CREATOR_ID",
  "TWITTER_API_KEY",
  "TWITTER_API_SECRET",
  "TWITTER_ACCESS_TOKEN",
  "TWITTER_ACCESS_TOKEN_SECRET",
  "COINGECKO_API_KEY",
];
function sanitizedEnv() {
  const clean = { ...process.env };
  for (const key of SECRET_ENV_KEYS) delete clean[key];
  return clean;
}

// ---------------------------------------------------------------------------
// Helper: run the binance-square-cli tool and parse JSON output
// ---------------------------------------------------------------------------
function runBsq(args) {
  try {
    const cmd = `node ${BSQ_CLI} ${args} --raw 2>/dev/null`;
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: sanitizedEnv(),
    });
    // The CLI prints JSON to stdout. --raw gives the full envelope.
    // Try to parse — sometimes there's debug output mixed in, so find the JSON.
    const lines = stdout.trim().split("\n");
    for (let i = 0; i < lines.length; i++) {
      try {
        return JSON.parse(lines.slice(i).join("\n"));
      } catch {}
    }
    return null;
  } catch (err) {
    console.log(`  CLI error: ${err.message}`);
    return null;
  }
}

function runBsqPretty(args) {
  try {
    const cmd = `node ${BSQ_CLI} ${args} --pretty 2>/dev/null`;
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      env: sanitizedEnv(),
    });
    return stdout.trim();
  } catch (err) {
    console.log(`  CLI error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// MODE 1: TREND SCAN
// Fetch the homepage feed, extract trending cashtags, generate a post
// about what's actually trending on Square right now, and publish it.
// ---------------------------------------------------------------------------
async function trendScan() {
  console.log("=== SCAN_MODE: trend ===");
  console.log("Fetching Binance Square homepage feed...\n");

  // Fetch 2 pages of the recommended feed
  const raw = runBsq("feed --pages 2 --size 20");
  if (!raw || !raw.success) {
    console.log("Could not fetch feed — scraper may be blocked. Exiting.");
    process.exit(0); // graceful exit, not an error
  }

  const posts = raw.data?.vos || [];
  console.log(`Fetched ${posts.length} posts from the feed.`);

  // Extract all cashtags mentioned across the feed
  const cashtagCounts = {};
  const topicCounts = {};
  for (const post of posts) {
    const text = post.bodyTextOnly || post.title || "";
    const tags = text.match(/\$[A-Z]{2,10}/g) || [];
    for (const tag of tags) {
      cashtagCounts[tag] = (cashtagCounts[tag] || 0) + 1;
    }
    // Extract first sentence as a rough "topic"
    const firstSentence = text.split(/[.!?]/)[0]?.trim();
    if (firstSentence && firstSentence.length > 10) {
      topicCounts[firstSentence] = (topicCounts[firstSentence] || 0) + 1;
    }
  }

  // Sort by frequency
  const trendingCoins = Object.entries(cashtagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  console.log("\nTrending cashtags across the feed:");
  for (const [tag, count] of trendingCoins) {
    console.log(`  ${tag}: mentioned in ${count} posts`);
  }

  if (trendingCoins.length === 0) {
    console.log("\nNo cashtags found in feed. Skipping post.");
    return;
  }

  // Pick top 3 trending coins (respecting Binance's 3-cashtag limit)
  const top3 = trendingCoins.slice(0, 3).map(([tag]) => tag);
  const allCoins = trendingCoins.map(([tag, count]) => `${tag} (${count} mentions)`).join(", ");

  // Build the post
  const lines = [];
  lines.push("🔥 Trending on Binance Square right now:");
  lines.push("");
  for (const [tag, count] of trendingCoins.slice(0, 5)) {
    lines.push(`• ${tag} — ${count} post${count > 1 ? "s" : ""}`);
  }
  lines.push("");
  lines.push("What's catching your attention today?");
  lines.push("Not financial advice. DYOR.");

  const postText = lines.join("\n");
  console.log(`\n--- Post preview ---`);
  console.log(postText);
  console.log(`--------------------`);

  // Check if we should actually post (requires Binance key)
  const binanceKey = process.env.BINANCE_SQUARE_OPENAPI_KEY;
  if (!binanceKey) {
    console.log("\nNo BINANCE_SQUARE_OPENAPI_KEY set — draft only, not posting.");
    return;
  }

  if (process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1") {
    console.log("[DRY RUN] Would post this to Binance Square.");
    return;
  }

  // Post via the official OpenAPI (same as daily post — NOT through the scraper)
  const res = await fetch("https://www.binance.com/bapi/composite/v1/public/pgc/openApi/content/add", {
    method: "POST",
    headers: {
      "X-Square-OpenAPI-Key": binanceKey,
      "Content-Type": "application/json",
      clienttype: "binanceSkill",
    },
    body: JSON.stringify({ contentType: 1, bodyTextOnly: postText }),
  });
  const data = await res.json();
  if (data.code === "000000" && data.data?.id) {
    console.log(`\n✓ Posted! View at: https://www.binance.com/square/post/${data.data.id}`);
  } else {
    console.log(`\n✗ Post failed: ${data.code} ${data.message || ""}`);
  }
}

// ---------------------------------------------------------------------------
// MODE 2: COMPETITOR SCAN — Deep Style Analysis
// Fetches up to 10 posts per creator, analyzes posting patterns:
// average length, cashtag strategy, hook types, emoji usage, question
// frequency, engagement per post. Outputs a structured analysis Issue
// so you can study what works and combine the best elements.
// ---------------------------------------------------------------------------
async function competitorScan() {
  console.log("=== SCAN_MODE: competitor (deep style analysis) ===");
  console.log(`Tracking ${TRACKED_CREATORS.length} creators:\n`);

  const allAnalyses = [];

  for (const creator of TRACKED_CREATORS) {
    console.log(`\nAnalyzing ${creator.label} (${creator.username})...`);

    // Get profile
    const userArgs = creator.isUid ? `user ${creator.username} --uid` : `user ${creator.username}`;
    const profile = runBsq(userArgs);

    if (!profile || !profile.success) {
      console.log(`  ⚠️ Could not fetch profile.`);
      allAnalyses.push({ creator, error: "Could not fetch profile" });
      continue;
    }

    const userInfo = profile.data || {};
    const squareUid = userInfo.squareUid || userInfo.squareUidEncrypted || creator.username;
    const displayName = userInfo.displayName || userInfo.authorName || creator.username;
    const followerCount = userInfo.followerCount || userInfo.fansCount || 0;
    const postCount = userInfo.postCount || userInfo.contentCount || 0;

    // Fetch their recent posts (up to 10 for deeper analysis)
    const postsResp = runBsq(`user-posts ${squareUid}`);
    let posts = [];
    if (postsResp && postsResp.success) {
      posts = (postsResp.data?.vos || postsResp.data?.items || []).slice(0, 10);
    }

    if (posts.length === 0) {
      console.log(`  ⚠️ No posts found.`);
      allAnalyses.push({ creator, displayName, error: "No posts found" });
      continue;
    }

    console.log(`  Fetched ${posts.length} posts. Analyzing patterns...`);

    // --- DEEP ANALYSIS ---
    const analysis = analyzePostingStyle(posts, displayName, creator.username, followerCount, postCount);
    allAnalyses.push(analysis);
    console.log(`  ✓ Analysis complete: avg ${analysis.avgLength} chars, ${analysis.avgCashtags} cashtags/post`);
  }

  // Build the Issue body with the full analysis
  const today = new Date().toISOString().slice(0, 10);
  const sections = [];

  // Summary comparison table
  sections.push("## Style Comparison Summary");
  sections.push("");
  sections.push("| Creator | Followers | Avg Length | Avg Cashtags | Avg Likes | Avg Comments | Emoji Use | Questions | Hook Style |");
  sections.push("|---------|-----------|------------|--------------|-----------|--------------|-----------|-----------|------------|");
  for (const a of allAnalyses) {
    if (a.error) {
      sections.push(`| ${a.creator.username} | — | — | — | — | — | — | — | ⚠️ ${a.error} |`);
    } else {
      sections.push(`| ${a.displayName} | ${a.followers} | ${a.avgLength} chars | ${a.avgCashtags} | ${a.avgLikes} | ${a.avgComments} | ${a.emojiStyle} | ${a.questionFrequency} | ${a.hookStyle} |`);
    }
  }
  sections.push("");

  // Key takeaways
  sections.push("## Key Takeaways");
  sections.push("");
  const takeaways = generateTakeaways(allAnalyses);
  for (const t of takeaways) {
    sections.push(`- ${t}`);
  }
  sections.push("");
  sections.push("---");
  sections.push("");

  // Per-creator deep dives
  for (const a of allAnalyses) {
    if (a.error) {
      sections.push(`### ${a.creator.username}`);
      sections.push(`⚠️ ${a.error}`);
      sections.push("");
      continue;
    }

    sections.push(`### ${a.displayName} (@${a.username})`);
    sections.push(`**Followers:** ${a.followers} · **Total posts:** ${a.totalPosts} · **Analyzed:** ${a.postsAnalyzed} recent posts`);
    sections.push("");

    sections.push("#### Posting Style");
    sections.push(`- **Average post length:** ${a.avgLength} characters (range: ${a.minLength}-${a.maxLength})`);
    sections.push(`- **Cashtags per post:** ${a.avgCashtags} average (range: ${a.minCashtags}-${a.maxCashtags})`);
    sections.push(`- **Most-used cashtags:** ${a.topCashtags}`);
    sections.push(`- **Emoji usage:** ${a.emojiStyle}`);
    sections.push(`- **Question frequency:** ${a.questionFrequency}`);
    sections.push(`- **Hook style:** ${a.hookStyle}`);
    sections.push(`- **Posting cadence:** ${a.cadence}`);
    sections.push("");

    sections.push("#### Engagement");
    sections.push(`- **Average likes:** ${a.avgLikes} (range: ${a.minLikes}-${a.maxLikes})`);
    sections.push(`- **Average comments:** ${a.avgComments} (range: ${a.minComments}-${a.maxComments})`);
    sections.push(`- **Best-performing post:** ${a.bestPost ? a.bestPost.likes + " likes" : "n/a"}`);
    if (a.bestPost) {
      sections.push(`  > "${a.bestPost.text}"`);
      sections.push(`  🔗 ${a.bestPost.url}`);
    }
    sections.push("");

    sections.push("#### Recent Post Samples (3)");
    sections.push("");
    for (const sample of a.samples) {
      const preview = sample.text.length > 250 ? sample.text.substring(0, 250) + "..." : sample.text;
      sections.push(`> ${preview}`);
      sections.push(`> ❤️ ${sample.likes} · 💬 ${sample.comments} · ${sample.cashtags || "no cashtags"}`);
      sections.push(`> 🔗 ${sample.url}`);
      sections.push("");
    }

    sections.push("#### What to Learn From This Creator");
    sections.push(`- ${a.takeaway}`);
    sections.push("");
    sections.push("---");
    sections.push("");
  }

  sections.push("## How to Use This Data");
  sections.push("");
  sections.push("1. **Don't copy their voice** — combine their *techniques* (hook style, cashtag placement, post length) with your own voice.");
  sections.push("2. **Note the engagement patterns** — which post types get the most likes/comments? Do longer or shorter posts perform better?");
  sections.push("3. **Cashtag strategy** — how many cashtags do the top performers use? Which coins get the most engagement?");
  sections.push("4. **Hook study** — how do they open their posts? A question? A stat? A bold claim? Steal the structure, not the words.");
  sections.push("5. **Apply to your weekly article** — the Sunday article is where your human voice matters most. Use these patterns there.");
  sections.push("");
  sections.push("---");
  sections.push("Close this issue when you've reviewed it.");

  const issueBody = [`# 📊 Competitor Style Analysis — ${today}`, "", ...sections].join("\n");

  console.log("\n---ISSUE_BODY_START---");
  console.log(issueBody);
  console.log("---ISSUE_BODY_END---");
}

// ---------------------------------------------------------------------------
// Deep analysis: extract posting style patterns from a set of posts
// ---------------------------------------------------------------------------
function analyzePostingStyle(posts, displayName, username, followers, totalPosts) {
  const texts = posts.map(p => p.bodyTextOnly || p.title || "");
  const lengths = texts.map(t => t.length).filter(l => l > 0);
  const allCashtags = [];
  const cashtagCounts = texts.map(t => {
    const tags = t.match(/\$[A-Z]{2,10}/g) || [];
    allCashtags.push(...tags);
    return tags.length;
  });
  const likes = posts.map(p => p.likeCount || p.likes || 0);
  const comments = posts.map(p => p.commentCount || p.comments || 0);
  const emojiRegex = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{27BF}]/gu;
  const emojiCounts = texts.map(t => (t.match(emojiRegex) || []).length);
  const questionCounts = texts.map(t => (t.match(/\?/g) || []).length);

  // Hook analysis: what pattern does the first sentence follow?
  const hooks = texts.map(t => {
    const firstLine = t.split(/[\n.!?]/)[0]?.trim() || "";
    if (/\$[A-Z]/.test(firstLine)) return "cashtag-led";
    if (/\d/.test(firstLine) && /%|\$/.test(firstLine)) return "stat-led";
    if (firstLine.endsWith("?")) return "question-led";
    if (/^[A-Z]/.test(firstLine) && firstLine.length < 80) return "headline-led";
    return "narrative-led";
  });
  const hookCounts = {};
  hooks.forEach(h => hookCounts[h] = (hookCounts[h] || 0) + 1);
  const dominantHook = Object.entries(hookCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "varied";
  const hookStyleMap = {
    "cashtag-led": "Opens with a $cashtag (e.g. '$BTC is up...')",
    "stat-led": "Opens with a number/stat (e.g. 'Market cap at $2.28T...')",
    "question-led": "Opens with a question (e.g. 'What's happening with...?')",
    "headline-led": "Short headline-style opener",
    "narrative-led": "Opens with a sentence/conversation",
    "varied": "No single dominant pattern",
  };

  // Emoji style
  const totalEmojis = emojiCounts.reduce((a, b) => a + b, 0);
  const emojiStyle = totalEmojis === 0 ? "No emojis" :
    totalEmojis / posts.length < 1 ? "Minimal (0-1 per post)" :
    totalEmojis / posts.length < 3 ? "Moderate (1-3 per post)" :
    "Heavy (3+ per post)";

  // Question frequency
  const totalQuestions = questionCounts.reduce((a, b) => a + b, 0);
  const questionFrequency = totalQuestions === 0 ? "Never asks questions" :
    totalQuestions / posts.length < 0.5 ? "Rarely asks questions" :
    totalQuestions / posts.length < 1 ? "Sometimes asks questions" :
    "Frequently asks questions (engagement driver)";

  // Top cashtags
  const cashtagFreq = {};
  allCashtags.forEach(t => cashtagFreq[t] = (cashtagFreq[t] || 0) + 1);
  const topCashtags = Object.entries(cashtagFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => `${tag} (${count}x)`)
    .join(", ") || "none";

  // Best post by likes
  let bestPost = null;
  let bestIdx = -1;
  for (let i = 0; i < posts.length; i++) {
    const l = likes[i] || 0;
    if (l > (bestPost?.likes || 0)) {
      bestIdx = i;
      bestPost = {
        likes: l,
        comments: comments[i] || 0,
        text: texts[i],
        url: posts[i].id ? `https://www.binance.com/square/post/${posts[i].id}` : "",
      };
    }
  }

  // Cadence estimation (rough — based on timestamps if available)
  const timestamps = posts.map(p => p.createTime || p.date).filter(Boolean);
  let cadence = "unknown";
  if (timestamps.length >= 2) {
    const sorted = timestamps.sort((a, b) => b - a);
    const gaps = [];
    for (let i = 0; i < sorted.length - 1; i++) {
      gaps.push(sorted[i] - sorted[i + 1]);
    }
    const avgGapMs = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    const avgGapHours = avgGapMs / (1000 * 60 * 60);
    if (avgGapHours < 6) cadence = `~${avgGapHours.toFixed(1)}h between posts (very active)`;
    else if (avgGapHours < 24) cadence = `~${avgGapHours.toFixed(1)}h between posts (daily+)`;
    else if (avgGapHours < 72) cadence = `~${(avgGapHours / 24).toFixed(1)} days between posts`;
    else cadence = `~${(avgGapHours / 24 / 7).toFixed(1)} weeks between posts`;
  }

  // Takeaway
  let takeaway = "";
  if (dominantHook === "stat-led") takeaway = "Leads with data — readers know immediately what they're getting. Consider opening your posts with the most surprising number.";
  else if (dominantHook === "question-led") takeaway = "Uses questions as hooks — drives comments and engagement. Try opening a post with a question instead of a statement.";
  else if (dominantHook === "cashtag-led") takeaway = "Leads with the coin — gets cashtag clicks early. Consider putting your first cashtag in the opening sentence.";
  else takeaway = "Varied hook style — doesn't rely on one pattern. Experiment with different openers to see what resonates with your audience.";

  if (emojiStyle === "Heavy (3+ per post)") takeaway += " Heavy emoji user — emojis add visual breaks but can feel cluttered. Use sparingly.";
  if (questionFrequency.includes("Frequently")) takeaway += " Frequent questions = high comment engagement. Make sure your posts end with a question.";

  // Samples (3 posts)
  const samples = posts.slice(0, 3).map((p, i) => ({
    text: texts[i] || "(no text)",
    likes: likes[i] || 0,
    comments: comments[i] || 0,
    cashtags: (texts[i].match(/\$[A-Z]{2,10}/g) || []).join(", "),
    url: p.id ? `https://www.binance.com/square/post/${p.id}` : "",
  }));

  return {
    displayName, username, followers, totalPosts,
    postsAnalyzed: posts.length,
    avgLength: Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length),
    minLength: Math.min(...lengths),
    maxLength: Math.max(...lengths),
    avgCashtags: (cashtagCounts.reduce((a, b) => a + b, 0) / cashtagCounts.length).toFixed(1),
    minCashtags: Math.min(...cashtagCounts),
    maxCashtags: Math.max(...cashtagCounts),
    topCashtags,
    emojiStyle,
    questionFrequency,
    hookStyle: hookStyleMap[dominantHook] || dominantHook,
    cadence,
    avgLikes: Math.round(likes.reduce((a, b) => a + b, 0) / likes.length),
    minLikes: Math.min(...likes),
    maxLikes: Math.max(...likes),
    avgComments: Math.round(comments.reduce((a, b) => a + b, 0) / comments.length),
    minComments: Math.min(...comments),
    maxComments: Math.max(...comments),
    bestPost,
    takeaway,
    samples,
  };
}

function generateTakeaways(analyses) {
  const takeaways = [];

  // Find highest engagement creator
  const valid = analyses.filter(a => !a.error);
  if (valid.length === 0) return ["No data to analyze — all creators failed to fetch."];

  const byEngagement = [...valid].sort((a, b) => (b.avgLikes + b.avgComments) - (a.avgLikes + a.avgComments));
  const top = byEngagement[0];
  takeaways.push(`**${top.displayName}** has the highest average engagement (${top.avgLikes} likes, ${top.avgComments} comments per post). Study their hook style: ${top.hookStyle.toLowerCase()}.`);

  // Post length insight
  const avgLen = valid.reduce((s, a) => s + a.avgLength, 0) / valid.length;
  const longest = [...valid].sort((a, b) => b.avgLength - a.avgLength)[0];
  const shortest = [...valid].sort((a, b) => a.avgLength - b.avgLength)[0];
  takeaways.push(`Average post length across all creators: ${Math.round(avgLen)} chars. Longest: ${longest.displayName} (${longest.avgLength} chars). Shortest: ${shortest.displayName} (${shortest.avgLength} chars).`);

  // Cashtag insight
  const avgTags = valid.reduce((s, a) => s + parseFloat(a.avgCashtags), 0) / valid.length;
  takeaways.push(`Average cashtags per post: ${avgTags.toFixed(1)}. Binance's limit is 3 — most creators stay at or near the cap.`);

  // Question insight
  const questioners = valid.filter(a => a.questionFrequency.includes("Frequently") || a.questionFrequency.includes("Sometimes"));
  if (questioners.length > 0) {
    takeaways.push(`${questioners.length} of ${valid.length} creators regularly ask questions — this drives comment engagement. Make sure your posts end with a curiosity question.`);
  }

  // Emoji insight
  const emojiUsers = valid.filter(a => a.emojiStyle !== "No emojis");
  if (emojiUsers.length === 0) {
    takeaways.push("None of the tracked creators use emojis heavily — clean text posts perform well on Square.");
  } else {
    takeaways.push(`${emojiUsers.length} of ${valid.length} creators use emojis. ${emojiUsers[0].displayName} uses them ${emojiUsers[0].emojiStyle.toLowerCase()}.`);
  }

  return takeaways;
}

// ---------------------------------------------------------------------------
// MODE 3: COMMENT DIGEST
// Fetch comments on YOUR recent posts, surface new ones with AI-suggested
// replies. The AI drafts replies but does NOT post them — you review and
// reply manually from your phone. This is the human-in-the-loop pattern.
// ---------------------------------------------------------------------------
async function commentDigest() {
  console.log("=== SCAN_MODE: comments ===");

  if (!MY_CREATOR_ID) {
    console.log("SQUARE_CREATOR_ID not set — cannot fetch your posts. Skipping.");
    console.log("Find your creator ID in your Binance Square profile URL.");
    return;
  }

  console.log(`Fetching your recent posts (creator ID: ${MY_CREATOR_ID})...\n`);

  // Fetch your recent posts
  const postsResp = runBsq(`user-posts ${MY_CREATOR_ID}`);
  if (!postsResp || !postsResp.success) {
    console.log("Could not fetch your posts — scraper may be blocked. Exiting.");
    process.exit(0);
  }

  const myPosts = (postsResp.data?.vos || postsResp.data?.items || []).slice(0, 5);
  console.log(`Found ${myPosts.length} recent posts.`);

  if (myPosts.length === 0) {
    console.log("No posts found. Exiting.");
    return;
  }

  const sections = [];

  for (const post of myPosts) {
    const postId = post.id;
    const postText = (post.bodyTextOnly || post.title || "").substring(0, 150);
    const commentCount = post.commentCount || post.comments || 0;

    if (commentCount === 0) continue;

    console.log(`  Post ${postId}: ${commentCount} comments. Fetching detail...`);

    // Fetch post detail (includes comments)
    const detailResp = runBsq(`post ${postId}`);
    if (!detailResp || !detailResp.success) {
      continue;
    }

    const detail = detailResp.data || {};
    const comments = detail.commentList || detail.comments || [];

    if (comments.length === 0) continue;

    const lines = [];
    lines.push(`### Post: "${postText}..."`);
    lines.push(`🔗 https://www.binance.com/square/post/${postId}`);
    lines.push(`❤️ ${post.likeCount || 0} · 💬 ${commentCount}`);
    lines.push("");

    for (const comment of comments.slice(0, 10)) {
      const author = comment.authorName || comment.userName || "Anonymous";
      const text = comment.content || comment.bodyTextOnly || "";
      const time = comment.createTime || comment.date || "";

      lines.push(`> **${author}** said: ${text}`);

      // Generate a suggested reply using the AI provider chain
      // (if available — if not, just note "consider replying")
      if (process.env.GROQ_API_KEY || process.env.OPENROUTER_API_KEY || process.env.GEMINI_API_KEY) {
        const suggestedReply = await generateSuggestedReply(text, postText);
        if (suggestedReply) {
          lines.push(`  💡 Suggested reply: ${suggestedReply}`);
        }
      } else {
        lines.push(`  💡 Reply manually from your phone.`);
      }
      lines.push("");
    }

    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) {
    console.log("\nNo comments found on your recent posts.");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const issueBody = [
    `# Comment Digest — ${today}`,
    "",
    "New comments on your recent Binance Square posts.",
    "Suggested replies are drafts — review and post manually from your phone.",
    "DO NOT auto-post replies (bot pattern = ban risk).",
    "",
    "---",
    "",
    ...sections,
    "",
    "---",
    "Close this issue when you've reviewed the comments and replied.",
  ].join("\n");

  console.log("\n---ISSUE_BODY_START---");
  console.log(issueBody);
  console.log("---ISSUE_BODY_END---");
}

// ---------------------------------------------------------------------------
// Helper: generate a suggested reply using the AI provider chain
// ---------------------------------------------------------------------------
async function generateSuggestedReply(commentText, postContext) {
  const prompt = [
    "A reader commented on a Binance Square crypto market post.",
    "Generate a short, friendly, factual reply (max 150 chars).",
    "No trading suggestions. No price predictions. End with a question if natural.",
    "",
    `Post context: ${postContext}`,
    `Comment: "${commentText}"`,
    "",
    "Reply:",
  ].join("\n");

  // Try Groq first
  const providers = [
    { name: "groq", key: process.env.GROQ_API_KEY, url: "https://api.groq.com/openai/v1/chat/completions", model: "llama-3.3-70b-versatile" },
    { name: "openrouter", key: process.env.OPENROUTER_API_KEY, url: "https://openrouter.ai/api/v1/chat/completions", model: "meta-llama/llama-3.3-70b-instruct:free" },
  ];

  for (const p of providers) {
    if (!p.key) continue;
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: { "Authorization": `Bearer ${p.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: p.model,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 100,
          temperature: 0.4,
        }),
      });
      if (!res.ok) continue;
      const data = await res.json();
      const text = data.choices?.[0]?.message?.content?.trim();
      if (text && text.length > 10 && text.length < 300) return text;
    } catch {}
  }

  return null;
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function main() {
  console.log(`\n🔍 Binance Square Scanner — SCAN_MODE: ${SCAN_MODE}\n`);

  // Verify the CLI tool exists
  if (!fs.existsSync(BSQ_CLI)) {
    console.error(`ERROR: binance-square-cli not found at ${BSQ_CLI}`);
    console.error("The workflow must clone and build it before running this script.");
    process.exit(1);
  }

  switch (SCAN_MODE) {
    case "trend":
      await trendScan();
      break;
    case "competitor":
      await competitorScan();
      break;
    case "comments":
      await commentDigest();
      break;
    default:
      console.error(`Unknown SCAN_MODE: ${SCAN_MODE}. Use: trend, competitor, comments`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Scan failed:", err.message);
  process.exit(1);
});
