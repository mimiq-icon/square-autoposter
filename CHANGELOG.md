# Changelog

Reconstructed from the version-tagged comments already in `post.mjs` and `scan.mjs` (every change in this codebase has always been commented in place with a `vN` marker) plus this pass's own work. If you're looking for *why* a particular line exists, search the source for its version tag first — the reasoning usually lives right there.

## v10.1 (PC runner, local model, shared state)

- **NEW:** `local-runner.mjs` + `start-news.bat` — runs the news pipeline on your PC every ~2.5 minutes (`NEWS_POLL_SEC`) as a supervised loop (each cycle is a child process with a timeout, failures back off, logs go to `logs/news.log`). Flags: `--once`, `--dry-run`, `--check`. Reads settings from a git-ignored `.env` (`.env.example` provided). The PC does not need to be on 24/7: `news-post.yml` keeps running hourly as the backup.
- **NEW:** Ollama provider (`OLLAMA_MODEL`, optional `OLLAMA_BASE_URL`) — a model on your own machine, spoken to over localhost; no key, no internet, no cost. `AI_PROVIDER_ORDER` controls the order providers are tried. 240s timeout for slow CPU inference; `<think>…</think>` blocks are stripped.
- **NEW:** git claim lock (`news-sync.mjs`) — a runner pushes a claim for a story before publishing; git rejects the second pusher, so the PC and GitHub can't post the same story. Built with git plumbing so it never touches your working tree, index or checked-out branch. Failed publishes release the claim. State entries now carry a status (`posted` / `pending` / `skipped`); the daily count is derived from them.
- **NEW:** Telegram one-tap approval (`telegram.mjs`) — sensitive stories (or all, `NEWS_APPROVAL=all`) are sent to your phone with [Post]/[Skip]. Nothing is posted without a tap; no tap before `NEWS_APPROVAL_WAIT_MIN` = dropped. Only taps from your `TELEGRAM_CHAT_ID` count, buttons are bound to one story, stale taps are drained first.
- **NEW:** sensitive-claim rule — hacks, thefts, arrests, bankruptcies, depegs, bans and deaths are never posted from a single outlet; they wait for a second outlet or an official source.
- **NEW:** official feeds — SEC press releases and Federal Reserve press releases (filtered to crypto/macro relevance), with an importance bonus.
- **NEW:** `NEWS_MIN_GAP_MIN` minimum gap between posts, one pending approval at a time, conditional-GET (ETag / Last-Modified) feed caching for fast polling, age-aware lead-in (🚨 BREAKING only for fresh high-score stories, 📰 NEWS for older ones).
- **CHANGED:** `news-post.yml` now claims through git itself (`NEWS_GIT_SYNC=true`, full-depth checkout, 15 min timeout); the old "Save posted-news state" step is removed.
- **FIX:** the script entry-point check compared `file://` + path, which never matches on Windows, so `node post.mjs` would silently do nothing there. Now uses `pathToFileURL`.
- **Tests:** 171 (new: `news-sync`, `telegram`, `local-runner`, and `e2e-news` which runs two simulated machines against a local git remote and asserts a single post).
- **Not verified live** (the build sandbox has no outbound network): the SEC and Federal Reserve feed URLs, real feed formats, Ollama speed on a CPU-only laptop, and real Telegram delivery. Everything else was exercised against mocks and real local git remotes. Start with `node local-runner.mjs --dry-run`.

## v10 (breaking-news mode)

- **NEW:** `RUN_MODE=news` + `news-post.yml` (hourly) + `news.mjs`. Reads crypto RSS feeds, clusters the same story across outlets, scores importance, and posts at most one wire-style story per run, with source attribution. Posts nothing when no story clears the bar.
- **NEW:** fact guard on AI rewrites — numbers (with units), names and coins in the output must appear in the source story, and links, hashtags, cashtags, emoji, predictions, trading advice and the existing banned-phrase list are rejected. One corrective retry per provider, then the cleaned original headline.
- **NEW:** cross-run dedupe via `news-state/posted.json` (committed back by the workflow), a UTC daily cap, and a run summary listing feed health and the top candidates with score reasons.
- **NEW:** `test/news.test.mjs` (35 tests, fixture-based, no network). Suite is now 113 tests.
- Not yet verified against live feeds: the sandbox this was built in has no outbound network, so feed fetching was exercised against mocked responses only. First real run should be a dry run.

## v9.5

- **NEW:** GitHub Actions Job Summary on every daily-post run — style, source (AI provider or template/fallback), length, cashtags, hashtags, image-attached, dry-run status, and a link to the post. No extra workflow step; `post.mjs` writes it directly to `$GITHUB_STEP_SUMMARY`.
- **NEW:** Scanner health visibility — `trend-scan`, `competitor-scan`, and `comment-digest` now each write a one-line OK/blocked status to the Job Summary, so a scraper block is visible without opening logs.
- **CHANGED:** `buildAiPost()` now returns `{ text, provider }` instead of discarding which AI provider actually succeeded (needed for the summary above).
- **FIX:** Removed a stray, misplaced `test/tests.yml` — GitHub Actions only reads workflows from `.github/workflows/`, so this file silently did nothing while looking like a second CI config.
- Added `README.md` and this changelog.

## v9.4

- **NEW:** Topic hashtags (`#Bitcoin`, `#Ethereum`, etc.), grounded in whichever `$cashtags` the post already contains — same "no ungrounded claims" principle the cashtag/coin-name checks already enforced, applied to a second discovery mechanism. Capped at 2 per post (no documented hard limit exists, unlike the 3-cashtag cap, so this is a deliberately conservative default). Applied to daily posts and the weekly article.
- **FIX:** `getMarketData()` — the one fetch every code path depends on — had no retry or timeout, unlike every other (optional) fetcher in `main()`. Added 2 retries with exponential backoff and a 15s per-attempt timeout.
- **FIX:** `RUN_MODE=top-movers-digest` was set by `top-movers-digest.yml` but never actually read in `main()` — every run fell through to the same rotation logic as the plain daily pipeline, using the *same* `dayIndex` as that morning's post. On the 8 days out of 9 the rotation didn't land on the digest style, this workflow posted a near-duplicate of the post already published hours earlier instead of the digest its own workflow describes.

## v9.3

- **FIX (security):** `scan.mjs`'s `runBsq()`/`runBsqPretty()` built shell command strings via template-literal interpolation and ran them through `execSync` (which spawns `/bin/sh -c`). Several call sites interpolated data this script doesn't control — a Binance-returned `squareUid`/`postId`, or the `SQUARE_CREATOR_ID` secret — straight into that string. Switched to `execFileSync` with an argv array, which never invokes a shell at all.
- Added `.github/workflows/test.yml` — the unit suite existed but nothing ran it automatically before this.

## v9.2

- **DIAGNOSTIC:** Clearer "no AI providers configured" logging.
- Explicit `permissions: contents: read` block on workflows — fixes "Repository not found" on private repos where the default `GITHUB_TOKEN` doesn't get read access automatically.

## v9.1

- **NEW:** Daily posts (not just the weekly article) can now attach a rendered chart — a bar chart of 24h % change for the featured coins, via the same `renderChartPng`/`uploadImageToSquare` infrastructure the weekly article already used for its cover image. Falls back to text-only if anything in the chart pipeline fails.

## v9

- **NEW:** Two more rotation styles — "digest" (top-100 breadth: best gainer, worst loser, % of top 100 green) and "spotlight" (deep-dive on one coin *outside* the 8-coin core watchlist). Both powered by a new `getBroadMarketMovers()` fetcher. Rotation array grew from 7 to 9 entries, staying coprime with the 5-vibe rotation (full vibe×template cycle: 45 days).
- **NEW:** Optional cross-post of the same daily text to X/Twitter, from the same account — one voice, syndicated, never a second independent-looking persona. Skips gracefully unless all 4 `TWITTER_*` secrets are set; never blocks or fails the Square post if the X call errors. Implements OAuth 1.0a signing directly (X requires user-context auth as of 2026; no new dependency added).
- **FIX:** `fmtPrice()` rounded any price under $0.0001 down to a misleading "$0.00" — fine for the original 8-coin watchlist, not fine once the top-100-wide digest/spotlight styles started surfacing sub-cent meme coins. Precision now scales with magnitude.
- **Scope note:** multi-account deployment, automated "Chat Room" bots, and CreatorPad reward-farming automation were in the brainstorm doc and deliberately left out — not a technical limitation, a line about not making one operator's accounts impersonate independent, organically-engaged voices/community.

## v8

- **BIGGEST CHANGE:** the Sunday weekly article no longer builds and publishes itself unattended. Split into `RUN_MODE=weekly-draft` (gathers data, writes a draft, zero Binance calls) and `RUN_MODE=weekly-publish` (posts only after a human labels the resulting GitHub Issue `approved-for-posting`). The old auto-publish ladder (article+chart → article-only → chart-only → text recap, all inside `main()`) is gone; weekdays are unaffected, and `main()` on a Sunday now just logs and returns.
- Unlike the daily post's "post something rather than skip a day" philosophy, `weekly-publish` fails loudly instead of silently substituting different content for what a human approved.

## v7

- Optional CoinGecko Demo API key support (`COINGECKO_API_KEY`) — moves off the shared keyless rate-limit bucket.
- Diagnostic `DAY_INDEX_OVERRIDE` — dry-run any vibe/template combination on demand instead of waiting for the calendar to cycle to it.
- Guarded `main()`'s auto-run behind an `import.meta.url` check so `post.mjs` can be imported by the test suite without hitting live network calls.
- Exported the pure functions (formatters, template builders, the validation gate) for unit testing.

## v6

- (Folded into the v5.x line below in the source comments — no distinct v6-only entry found.)

## v5 / v5.x

- 4 additional free data sources: CoinGecko `/search/trending`, CoinGecko `/global`, Alternative.me Fear & Greed, Binance `/api/v3/ticker/24hr` (~30-coin anomaly scan).
- 4 new templates: Macro Overview, Anomaly Radar, Trending Today, Market Sentiment. Smart selection order: Anomaly > Extreme Sentiment > Rotation.
- Vibe adherence validation (v5.6) — an early diagnostic showed the model silently dropping the day's "vibe" instruction; nothing checked whether it was actually followed. The vibe instruction was also moved to the *end* of the prompt (recency bias) rather than buried under DATA/CASHTAGS/STRUCTURE.
- Ungrounded-coin-name detection — catches the model naming a coin in plain prose (e.g. "Bitcoin") that isn't in today's actual data, a different failure mode than an extra `$cashtag`.
- Richer per-coin data fields (volume, market cap, rank, 24h high/low, ATH change%) captured from CoinGecko responses that were previously fetched and discarded.

## v4 / v4.x

- Multi-provider AI chain: Groq → OpenRouter → Gemini, with template as the final fallback. Each provider's output is validated before being accepted; a retryable failure (e.g. cashtag overcount) gets one corrective retry with a prompt that shows the model exactly what it got wrong.
- **BUG FIX:** the model was copying example `$COIN1`/`$COIN2` placeholders into real output.

## v3 / v3.x

- **BUG FIX:** text posts now explicitly send `contentType: 1`. Without it, Binance treated posts as articles and only displayed the first ~6 words.
- **NEW:** long-form weekly ARTICLE builder (title + markdown body + 7-day chart).
- **NEW:** length guard — posts over 1500 chars are auto-shortened by trimming trailing lines rather than being silently truncated by Binance.
- Centralized dry-run gating inside `squareApi()` so no code path (text post, article, image upload, image status poll) can bypass it.

## v2

- Initial multi-source data + template variety pass (see v5 section above — v2's additions were superseded/absorbed rather than being a separate current feature set).

## v1

- Original script: single data source, single template, no dry-run, no validation. (Not separately documented in-repo; earliest in-code comments start from the v2 baseline.)
