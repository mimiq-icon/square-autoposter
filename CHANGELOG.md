# Changelog

Reconstructed from the version-tagged comments already in `post.mjs` and `scan.mjs` (every change in this codebase has always been commented in place with a `vN` marker) plus this pass's own work. If you're looking for *why* a particular line exists, search the source for its version tag first — the reasoning usually lives right there.

## v11.10 (operating-loop pass: the live path, the packaging, the fallback)

This pass did not add a format. It closed the gaps `STRATEGY.md` itself named, and fixed the things the last uploaded snapshot broke.

- **The hourly GitHub news runner now actually asks you first.** The repo secrets existed, but `news-post.yml` never passed `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` to the job, so `telegramConfigured()` was false there and sensitive stories posted without the tap `STRATEGY.md` assumed they got. Both are now passed. `alert-post.yml` gets the same two lines.
- **Research no longer goes dark when no AI is available.** Every other writer had a template fallback; the research desk instead skipped the topic (`No validated AI copy — skipping this topic`), which is what the last dry run showed. `buildResearchTemplateCopies()` now builds a copy from the vetted concept notes (education topics) or the fetched fact text (data topics), the caller validates each candidate and uses the first that passes. `provider` is reported as `template`, the article drops its "idea, step by step" section when the copy already carries the notes, and a concept-notes-only post credits no source it did not use.
- **Two topics could never publish.** `wiki:Total value locked` and `wiki:Layer 2 (blockchain)` both return HTTP 404 from Wikipedia, so `what-is-tvl` and `what-is-a-layer-2` failed their two-source minimum on every run forever. TVL now points at the live "Decentralized finance" article; layer 2 is an explicit `notesOnly` explainer (no live source, concept notes only) instead of being grounded in a page that does not exist. The topic test now enforces "a live source, unless notesOnly with real notes".
- **The duplicate test files are gone.** The last upload put 22 copies of `test/*.test.mjs` in the repo root with the `../` imports stripped; `node --test` discovered both sets and every root copy failed to import, turning the suite red (42 failures, 0 real). Deleted, plus the stray `test/tests.yml`. `check-sync.mjs` and `run-mode.mjs` were also missing from the test workflow's path filter.
- **Generated output is untracked.** `card-previews/` (16 files) and `weekly-draft.json` are in `.gitignore` and out of the index. Tracking them made `check-sync` report "MODIFIED: same commit as GitHub, but code files differ" after every dry run.
- **`save-and-push.bat`** commits and pushes from the PC, so a change does not have to travel as a zip through the GitHub web UI (which is how the folder got flattened in the first place).
- **`save-and-push.bat` pulls before it pushes.** The first version did a plain `git push` and was rejected on its first use: the bot commits a claim to `main` on every story it posts, so the remote is almost always ahead. It now runs `git pull --rebase origin main` first, has an explicit conflict path that keeps the remotely-added claims, and every doc that mentions it says the same thing: never `git push --force` here, because that history is what stops the bot reposting.
- 521 tests (was 518): every topic must produce a mechanical copy that passes the grounding validator, the copy must be declarative and dash-free, and a short interrogative title must still get a valid hook.
- **Docs brought back in line with the code.** README: "10 rotating styles" (it listed 10 and said 9), the missing `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` row in the secrets table, a stale sentence in the research run-mode row, the 521 test count, and the push rule the bot's own commits create. STRATEGY: retitled to v11.10 with the four new findings, the live-path item marked done, and a 30-day plan that starts from where the code actually is. PC-SETUP: the setup check that told you to run `git push --dry-run` (which now always "fails" for the reason above), the "upload the files" wording that produced the zip uploads, and the "Updating the code later" flow that opened with `git reset --hard` — which would have thrown away unpublished commits, the exact situation a rejected push puts you in. `check-sync.mjs` now prints `git pull --rebase` first and labels `reset --hard` as destructive; its test asserts that order.

## v11.9 (Stage 4b of the quality rebuild: the strategy pass)

- **`STRATEGY.md` (new):** a review of the whole desk using your master-prompt frame (strategist, operator, quality reviewer, real limits): what "better" means, the real constraints, what each stage found, ideas ranked by impact and effort, what was deliberately not built and why, and a 30-day plan. Its top recommendation: make the unattended GitHub hourly news workflow ask for approval (add the two Telegram secrets) or disable it, since it is the one path where a plain-template post can go out unseen.
- **A weekly short DATA post.** Research topics (the data ones) used to appear once a month, as the long article, while two explainers went out every week. The Friday run now publishes a short post from a research topic with a ranked-bar chart of its own numbers; Tuesday stays an explainer and the first Saturday stays the long article. `RESEARCH_DATA_DAY` sets the weekday (`mon`..`fri`, or `off`; Saturday is refused because it is the article's day). `RESEARCH_MODE=data` forces one; a forced research topic with no mode is still the long article. The Telegram preview calls the image "Chart for this post".
- 518 tests (was 512): the weekday parser, and two end-to-end runs (data mode makes a short chart post; without it a forced research topic is still the article).


## v11.8 (Stage 4a of the quality rebuild: more data, real charts)

- **Six new data sources**, all free and keyless, with response shapes checked against the providers' docs: DefiLlama stablecoins (note: `circulating` is an object keyed by peg type, not a number), DefiLlama chains (TVL by chain), DefiLlama fees; mempool.space difficulty adjustment, block height and mining pools. Each has a tolerant parser: an unexpected shape is reported as "the format may have changed" (Stage 3), never posted.
- **Bitcoin supply is computed, not scraped.** From the tip block height: subsidy, halvings so far, blocks to the next halving, BTC mined. Checked against known chain facts (exactly 19,687,500 BTC at block 839,999; 3.125 BTC subsidy after the 4th halving; never above 21 million).
- **Six new topics (11 → 17):** how the halving works, how mining difficulty adjusts, who mines Bitcoin blocks, where stablecoin supply sits, where DeFi deposits live, what DeFi protocols collect in fees. Each has vetted concept notes; the three education/explainer ones need two independent sources (Stage 3's minimum applies).
- **Ranked-bar charts (`buildRankedBarsSvg`).** Left-aligned bars on a baseline in the brand yellow, the leader at full strength and the rest dimmed, values at the bar ends, source and date in the footer. Not green/red: those mean up/down and a share is neither. Research topics with chartable numbers now use the chart of their own data as the image (stablecoin supply, TVL by chain, fees, pool share of blocks, DEX share, top protocols); the article cover is the fallback, and education topics keep the explainer slide.
- **Finding:** research topics are always published as the monthly long-form article (first Saturday), and only education topics are short posts. So the data topics appear about once a month in rotation. Chart condition fixed accordingly (it first only applied to short posts, which research topics never are).
- 512 tests (was 469): `test/research-sources.test.mjs` (parsers against real-shaped fixtures, supply arithmetic, and a guard that runs all 17 topics through fact-gathering and chart-building), plus three end-to-end research tests through the real `post.mjs`. Shared fixtures live in `test-support/fixtures.mjs`.

## v11.7 (Stage 3 of the quality rebuild: research reliability)

- **Every failed source now says why.** Node reports every network problem as "fetch failed". The log now says "timed out", "DNS lookup failed (ENOTFOUND)", "connection refused", "connection dropped", "HTTP 403 (blocked)", "HTTP 429 (rate limited)", "response was not valid JSON", with the attempts and seconds: `FAILED: DefiLlama (defillama-protocols): HTTP 503 (3 attempts, 2.9s)`. The same reasons go into the GitHub Job Summary under "Failed sources".
- **Retries.** Network errors, timeouts, HTTP 429 and 5xx are retried (default 2 retries, 700ms then 1400ms backoff; a short `Retry-After` is respected). 403, 404 and malformed JSON are not retried, because retrying cannot fix them. `RESEARCH_RETRIES` sets the count.
- **A source that answers with nothing usable is reported.** A reshaped DefiLlama response, an empty fee table or a Wikipedia disambiguation page used to produce an empty block with no reason. It now says "answered, but no protocols could be read (the format may have changed)".
- **Failure reasons are no longer thrown away.** When every source failed, `gatherFacts` returned nothing and the reasons were lost. It now always returns what happened.
- **Concept notes are always in the facts.** Each topic's curated definitions were only printed in the article, never shown to the writer, so a Wikipedia outage left the model with no explanation to ground against. They are now a block of the facts (labelled "Concept notes", never credited as a source and never printed under "The numbers today"), and the prompt tells the model to use them for the explanation and the data lines for figures.
- **Minimum independent sources.** DefiLlama's two endpoints count as one source. A topic that declares two independent sources (for example Wikipedia and DefiLlama) is not posted on one: the log says why, nothing is made, and the topic is not marked as used so a later run retries it. `RESEARCH_MIN_SOURCES` overrides it (capped at what the topic declares, so no topic can be made unpostable).
- **Sources are fetched in parallel**, and each is credited once.
- 469 tests (was 435): `test/research-reliability.test.mjs` plus four end-to-end research tests through the real `post.mjs` (healthy, source down, minimum relaxed, source answering with garbage). The test mock gained a DefiLlama endpoint with failure modes.

## v11.6 (Stage 2 of the quality rebuild: alerts)

- **Noise alerts stopped.** A level alert used to fire whenever the price 30 minutes ago and the price now were on opposite sides of a round level, even by cents (BNB drifting from $740.31 to $739.98 posted "falls below $740"). Now both prices must be at least `ALERT_LEVEL_MARGIN_PCT` (0.15%) past the level. If the nearest level is not clean, an earlier level that is clean is used.
- **Second price source.** Before an alert is claimed, Binance's price is compared with CoinGecko's. More than `ALERT_PRICE_TOLERANCE_PCT` (2%) apart and the alert is held, with nothing claimed or posted: a wrong "falls below $83,000" is worse than a missed one. CoinGecko is called only when an alert is about to fire. A coin with no mapped id, or a failed lookup, posts unchecked and the log says so.
- **Context from real candles.** "Lowest since Nov. 6" (or "highest since") from 168 hourly Binance candles, only when it is true, the history is at least 3 days, and the answer is more than 24 hours old. If nothing in the week was that low it says "lowest in at least 7 days". The line is in the facts the model sees, so the validator allows the date, and the plain template leads with it. A date the model invents is still rejected.
- **The glowing line is the default chart again.** Candlesticks are opt-in with `ALERT_CHART_STYLE=candles`. News cards are unchanged.
- **Card hero matches the headline.** A 24h-move alert's card showed a 30-minute flash figure ("−3.2% in 30 min") under a 24h headline ("down 9.0% in 24 hours"). It now shows the 24h figure when that is itself extreme; level alerts still lead with the fast move.
- 435 tests (was 403): `test/alerts-stage2.test.mjs` plus five end-to-end tests through the real `post.mjs` (sources agree, sources disagree, second source down or off, context line, chatter). The test mock gained a CoinGecko price endpoint and an hourly-history option.

## v11.5 (Stage 1 of the quality rebuild: the writing)

A rebuild of the "v12" writing overhaul that was lost in a sandbox reset. Done in stages, each shipped as its own zip.

- **`style.mjs` (new): a voice linter used by every writer.** It rejects the machine-written habits seen in the dry-run logs: scene-setting openers ("Ever wonder"), "not just X but Y", closing questions, dashes used as a flourish, mood-of-the-market phrases ("search interest splits between macro staples and smaller names"), hype words, and buzzwords ("spotlight", "landscape", "underscores"). A failure is retryable: the model is told why and tries again; after that the plain template is used. Numeric ranges like 3–5% are not treated as flourishes.
- **All five writers now carry the same style guide** (news, alerts, daily, research, weekly article) and run the lint on what comes back. Compliance checks (predictions, advice) still run first so their reasons win.
- **No closing questions anywhere.** The daily post's "Contrarian Question" vibe, which forced every fifth post to end on a question, is replaced by "Closing Fact". The research post no longer has a QUESTION line; a model that adds one is ignored. Single and multi-coin daily posts no longer ask for a CTA.
- **Plainer disclaimers.** "NFA", "DYOR", "Always DYOR", "for information only" and dash-joined variants are gone. News and daily posts rotate between "Not financial advice." and "Not financial advice. Do your own research."; research posts and the weekly recap use "Not financial advice."
- **Cloud models first.** The PC runner used to put the local Ollama model first whenever one was installed. A 3B model on a laptop wrote the flattest copy, so it is now the offline backup only (`AI_PROVIDER_ORDER=ollama,groq` puts it first again if you want it).
- **Name check fixed.** Real headlines use the curly apostrophe, so "Robinhood’s" was rejected as an unknown name; and "Securities and Exchange Commission" was rejected when the source said "SEC". Both are now grounded (a table of common acronym pairs, in both directions). A truly unknown name is still rejected.
- **Attribution bug fixed.** "Analyst Min Jung of Presto Labs said…", the exact format the news prompt teaches, was being rejected because only "analysts at <firm>" counted as owned. A named person now owns the view.
- Prompt examples that themselves contained dash flourishes or "not just…" were rewritten so the prompts never teach what the lint rejects.
- 403 tests (was 361): `test/style.test.mjs` covers the exact lines from your logs (must be caught), realistic wire copy (must pass), the name fixes, and that every prompt carries the voice rules.

## v11.4.1 (repo hygiene after v11.4; plus a per-feed off switch)

- **`.env.example` restored.** The copy on GitHub was an old one: it had lost the alerts, weekly-article, card, research and `SEC_USER_AGENT` / `NEWS_FETCH_TIMEOUT_SEC` / `NEWS_DISCLAIMER` settings and still said `NEWS_MAX_PER_DAY=12` (the real default is 40). It is the full v11.3 file again.
- **Removed `test/tests.yml`.** An old, unused workflow copy that pointed at a path that does not exist (`.github/workflows/tests.yml`). The real one is `.github/workflows/test.yml`.
- **`card-previews/` is ignored again** (it is generated by `node preview-cards.mjs`; the v11.4 repo had it committed and the ignore line missing).
- **News card:** with a price chart, the chart now starts higher and is taller, so short headlines no longer leave a large empty band.
- **`NEWS_FEEDS_OFF=CryptoSlate`:** turn off any news feed by name. CryptoSlate refuses the PC's connection (HTTP 403) and showed as a failed feed every cycle.
- **`PC-SETUP.md`:** the "files you need in the repo" list now includes `check-sync.mjs`, `run-mode.mjs`, `make-avatar.mjs`, `preview-cards.mjs`, `brand/`, `test-support/` and the `.bat`/`.ps1` helpers.

## v11.4 (candlestick charts, one-piece T, plainer disclaimer)

- **Real candlestick charts.** Alert and extreme-move cards now draw proper OHLC candles (green body = closed up, red = closed down, wicks for high/low) with a volume strip underneath, the 24h high/low in the caption, the last close dotted across, and the crossed level still dashed. Extreme cards get the same candles with a glow. Binance already returns open/high/low/close/volume for the price history the bot fetched, so no new request is made. More than 48 candles are merged into 48 so the chart stays readable (`aggregateCandles`). News cards accept `candles` too. If only closing prices are available the old line is drawn, so nothing regresses.
- **The T is one piece.** The mark is a single outline with curved shoulders where the stem leaves the tape strip (it used to be two rounded rectangles, and the bare stem read as an "I" under a bar). `brand/the-tape-avatar.svg/.png` regenerated.
- **Disclaimer:** "Reporting only, not trading advice." is gone from the rotation; the third news variant is now "Not financial advice. Do your own research."
- **Windows test fix:** the end-to-end tests passed `--import C:\...` to Node, which Windows rejects (`ERR_UNSUPPORTED_ESM_URL_SCHEME`, 26 failures in `dry-run-all`). They now pass a `file://` URL. The bot itself was never affected.
- **Tests:** 360 (new: candle aggregation, colours, volume, fallback, extreme/news candles, single-path mark).

## v11.3 (see what you approve, know what you run, dry-run everything)

- **You now SEE the card before you approve.** Cards used to be built after your tap, so Telegram showed only the text. News, alert (extreme moves) and research posts now send the exact card as a photo, *then* the Post/Skip buttons. The image is uploaded to Square only after you approve, so a skipped draft costs no upload (Binance allows 400 a day). A failed preview is non-fatal.
- **No "Binance" tag on alert cards** (it was hard-coded as the source). Alert and research cards have no footer text; set `CARD_HANDLE=@yourhandle` to show your handle small at the bottom of alert cards. News cards keep the publisher names (that is attribution).
- **Bundled font:** `brand/fonts/DejaVuSans*.ttf` (free licence included). Cards render identically on every machine; Windows would otherwise substitute Arial/Segoe and change the look and the text fit.
- **Price chips no longer cost you the card.** They come from Binance's free ticker first (no key, no quota), CoinGecko second, and if both fail the card is made without chips.
- **`node check-sync.mjs`** (or double-click `check-sync.bat`): "is this PC's code the same as GitHub's?" Fetches origin/main and compares code (not the bot's own state files); says up-to-date / behind / ahead / diverged / modified and prints the exact fix. `local-runner.mjs --check` and every runner start show the same line.
- **`node run-mode.mjs <mode>`**: run any part of the bot with your `.env` loaded, DRY by default (`news`, `alerts`, `research`, `daily`, `digest`, `weekly-approve`, ...; `list` shows modes and research topic ids; `--live` really posts). Extra `KEY=VALUE` arguments become environment variables.
- **`RESEARCH_TOPIC=<id>`** picks one education/research topic, so each can be dry-run. Research dry runs now write a PNG (not just an SVG).
- **`dry-run-all.ps1` rewritten** (and `dry-run-all.bat` to double-click): it now loads `.env` (the old one ran `node post.mjs` directly, without your keys, so the AI fell back to templates), covers every mode including `weekly-approve` (which sends nothing in dry-run, unlike the old comment claimed), starts with the sync check, ends with an OK/PROBLEM table, logs to `logs/dry-run-all-*.txt`, and `-AllTopics` dry-runs every research topic.
- **Tests:** 352 (new: `check-sync`, `run-mode`, and end-to-end card-preview tests with the real renderer: preview-before-approval, rejected = no upload, dry-run PNG, chips-failure, research per-topic).
- `test.yml` now installs the renderer so the card tests really render on GitHub.

## v11.2 (The Tape: rebrand, extreme-only alert images, audit fixes)

- **Brand:** every card now says THE TAPE with a vector mark (a "T" whose crossbar is a strip of ticker tape). "SQUARE DESK", "MARKET WIRE", "Binance market data" and the "down over the window" captions are gone. `node make-avatar.mjs` writes a matching profile picture to `brand/`.
- **Cards:** news card = big headline + coin chips + source once (no feed blurb, no disclaimer on the image; the post text carries it). Chips fit their text. Alert card has one chart instead of a range bar and a line saying the same thing; the line ends on a dot.
- **Alerts are text-only by default.** An image is attached only for violent moves: |24h change| >= `ALERT_CARD_MOVE_PCT` (8) or a move >= `ALERT_CARD_FLASH_PCT` (3) inside the lookback window. Those get a new glowing red (fall) or green (rise) card with a huge percentage and the real price line. `ALERT_CHART=all` restores a card on every alert; `off` removes images.
- **Dry runs now write the exact card** (SVG + PNG when the renderer is installed) to `logs/` for news and alerts.
- **Fixed docs that disagreed with the code:** `NEWS_MAX_PER_DAY` is 40 (docs said 12). Removed `NEWS_CHART_HOURS`: it was documented but never wired up, so news cards never had a price line.
- **Added:** `preview-cards.mjs`, `make-avatar.mjs`, `dry-run-all.ps1`.

## v11.1 (the desk, completed: the v10.2 work the v11 zip had silently lost)

The v11 zip was cut from a working tree that predated the v10.2 session's
afternoon work. Its changelog *claimed* some of those fixes were rebuilt —
they weren't, or only partially: the alerts feature, the AI-written weekly
article and both Telegram approval flows were missing entirely, and the
volume/market-cap data fixes existed only in the weekly template, not at the
data source. This release merges both lineages into one tree; every claim
below is backed by a test.

### Restored whole (were in v10.2, absent from v11)

- **Price alerts** (`alerts.mjs`, `RUN_MODE=alerts`, `alert-post.yml`, PC-runner cycle): "Bitcoin falls below $83,000" — Binance's public prices decide what happened, the AI only phrases it from validated facts, template as fallback, git-shared state so the PC and GitHub never double-alert.
- **The AI-written weekly article** (`article.mjs`, `RUN_MODE=weekly-approve`, `weekly-article-telegram.yml`): written only from a facts block (market stats, majors, the week's posted headlines), validated against it, sent **in full** to Telegram, published only on your tap. `weekly-article-draft.yml`'s schedule is off (the issue+label flow still works manually).
- **Telegram helpers**: `buildAlertApprovalMessage`, `buildArticleApprovalMessage`, `splitForTelegram`, `sendTextChunks` (4096-char chunking).
- **Data fixes at the source** (`getGlobalMarket`): the "$346169.28T" impossible-volume guard (`sanePositiveBelow` — daily volume can never exceed market cap; now guards daily templates, the AI article's facts AND the weekly template) and the `market_cap_change_percentage_24h_usd` field fix (the old name never existed — "n/a" in every post and article).
- **`fmtPrice` pinned to en-US** so a PC with another regional format can't print "$82 950,00"; plain-language hints on the two Binance limit errors (220009/220014); plain "rank 90" in the AI's data lines (no more issue links).
- **`NEWS_MAX_PER_DAY` back to 40** (Binance allows 100 API posts/day shared across all post types — news, alerts and the daily post share that budget).
- **Provider long-form support** (`opts.long`): the article needs 450–650 words; without it every provider capped at 800–4096 tokens and the article could truncate mid-sentence.

### Upgraded where the two lineages met

- **Alert cards** (`cards.mjs`): `buildAlertCardSvg` now takes an optional `sparkline` + `level` — the ALERT_CHART_HOURS price line with the crossed level drawn dashed, under the 24h range bar. Backward compatible (no sparkline → byte-identical v11 output). Alerts try the branded card first, fall back to the plain QuickChart price line when the PNG renderer isn't installed, then text-only; one klines fetch serves both paths.
- **Weekly article cover**: branded SVG cover (same brand system as news cards) with the rendered 7-day chart as fallback.
- **Duplicate normalisation** (`titleTokens`): merged the best of both — v10.2's magnitude-preserving unit normalisation ("$201 million" → token "201m", so "$7M" and "$7B" stay distinct — the v11 approach made them identical) plus v11's detected-coin symbol tokens ("Solana"/"SOL" both carry "sol"). The SkyAI pair merges; genuinely different stories don't.
- **`validateGroundedProse`** is exported again (the article validator), rebuilt on v11's helpers.
- **e2e coverage**: `e2e-alerts-weekly.test.mjs` and `e2e-news.test.mjs` clone ALL eight modules now; `dedupe.test.mjs` rewritten for the merged normalisation (the topic-window pacing it used to test lives in `etfFlowBlock`, covered by `news-opinion.test.mjs`).

### Housekeeping

- `test.yml` triggers on all module files (alerts, article, cards, research included).
- `alert-post.yml` installs the optional PNG renderer; `news-post.yml` documents the 40/day cap.
- `.env.example` regained the alerts + weekly-article sections next to the v11 card/research ones.
- **Suite: 323 tests** (v10.2: 276, v11: 253; the overlap was the shared modules' tests).
- **Not yet verified live** (same as v11): DefiLlama/mempool.space/Wikipedia shapes, card PNG upload to Square, real Telegram delivery, the branded alert card on a real run.

## v11 (the media desk: cards, education & research, and the lost v10.2 fixes rebuilt)

This release turns the bot into what the vision called a **small crypto media desk**: news, alerts, a weekly recap, education and research — every piece data-grounded, visually consistent, and approved on Telegram. It also rebuilds the production fixes that were lost when the previous session ended mid-build (the uploaded v10.2 zip predated them; the notes file is the record).

### The card engine (`cards.mjs`, new)

- **NEW:** every news post now carries a branded image, drawn in code as SVG — no design tools, no chart service, no dependencies. Seven builders share one brand system (palette, type scale, corner radius): **news cards**, **alert cards** (sharp single-coin moves, with a 24h range bar), **explainer slides** (reserved for education/research — news never gets slides, per the user's call), **bar charts**, **stat grids**, **line charts** and **article covers**.
- **NEW:** optional PNG rendering via `@resvg/resvg-js` (`npm install --no-save @resvg/resvg-js` — the one-time install; the news and research workflows do it automatically). Without it the bot posts text-only and logs why; a card that can't render never blocks a post. Cards are pure functions — byte-identical output for identical input — and every feed-supplied string is XML-escaped before it can reach the SVG.
- **NEW:** `NEWS_CARDS` (default on), `CARD_SCALE` (default 2×), and the two chart windows the dry-run notes argued for: **alerts show 24 hours** (`ALERT_CHART_HOURS`, the day's range gives a level cross context) and **news cards show 7 days** (`NEWS_CHART_HOURS`, the trend behind the story). The 48-hour default before was arbitrary — that's fixed by making both explicit and configurable.
- **NEW:** the text post no longer repeats the card. The AI now writes four lines (see below), and the image is the hook while the text is the story.

### The education & research desk (`research.mjs`, new; `RUN_MODE=research`)

- **NEW:** two or three short, data-grounded education posts a week (Tue/Fri, `research-post.yml`) and, once a month on the first Saturday, a long-form **article** (contentType 2). Short posts are the default format; article-form is the "once in a while" answer to the open question — both share the same grounding.
- **NEW:** facts come from free, key-less sources only — **DefiLlama** (`/protocols`, `/overview/dexs`), **mempool.space** (fee rates, 3-day hashrate), **Wikipedia** summary extracts for definitions. Topics declare what they need; a missing source thins the facts but a topic with *no* facts is skipped, never posted ungrounded.
- **NEW:** the AI writes only four labelled lines (HOOK / BODY / TAKEAWAY / QUESTION) from untrusted-marked facts, and `validateResearchCopy()` rejects any quantity not in the facts (with rounding tolerance), any coin not in the facts, any advice, prediction, own-opinion phrasing, link, cashtag or emoji. Derived numbers ("Uniswap carries 39.2% of volume") are computed **in code**, never by the model.
- **NEW:** full text goes to **Telegram for one-tap approval** before publishing (default when Telegram is configured; `RESEARCH_APPROVAL=off` to publish without asking, `RESEARCH_APPROVAL_WAIT_MIN=120` default wait — scheduled posts shouldn't need babysitting). Dry runs write an explainer-slide SVG preview into `logs/`.
- **NEW:** `research-state/published.json` remembers recent topics (rotation never repeats within a cycle) and guards same-day reruns (`RESEARCH_FORCE=true` overrides for manual reruns).

### Opinions, context and the richer news post (`news.mjs`)

- **NEW:** the news writer now produces **four** lines: HEADLINE, CONTEXT (facts only), **DETAIL** (1–2 factual sentences from the summary — the story behind the headline) and **REACTION** (an attributed opinion, or NONE).
- **CHANGED (opinion structure, not a rigid ban):** the v10.2 session rejected opinion-looking CONTEXT lines outright ("Min Jung suggests investors may prepare for a potential catch-up trade"). That fix stays — CONTEXT is facts-only — but the user's point stood: a third-party opinion is fine *when it stays theirs*. So opinions moved to REACTION with a reasoning structure the prompt explains and `validateReaction()` enforces: an attribution verb, a named owner (bare "analysts" needs a firm), no first person ("US" the country is not the pronoun "us" — the check is case-aware), numbers still grounded. Unattributed opinion remains rejected.
- **NEW:** ETF-flow pacing. "US Bitcoin ETFs draw $527M" and hours later "BlackRock's IBIT draws $665M" are the same *kind* of story: one flows stat per coin per day. One ETF-flow story per coin per **10 hours** now, tracked in shared state (`etfFlow` tags on claims). A **skipped** draft doesn't block; a **pending** one does.
- **FIX (duplicate detection, the SkyAI pair):** "…$201 million buyback" (The Block) vs "…$201M buyback" (Cointelegraph) scored 0.40 against the 0.45 cutoff because "$201 million" and "$201M" tokenized differently and SOL didn't match Solana. `titleTokens()` now strips unit suffixes after digits and adds every detected coin's canonical symbol as a token, so the pair merges — while "$201M" and "$7M" still never merge.
- **NEW:** news disclaimers rotate (3 variants, seeded by run hour), like the daily posts' closing line. A custom `NEWS_DISCLAIMER` stays fixed — your words aren't varied.

### Rebuilt v10.2-session fixes (they were lost with the session; the zip predated them)

- **FIX (weekly article data):** a draft had shown **"$346169.28T"** of 24h volume — daily volume can't exceed market cap, so impossible values are now dropped rather than printed. Another had shown "market cap rank **#90**", which GitHub auto-linked to issue #90; it's plain "rank 90" now.
- **CHANGED (scrapers):** Trend Scan and Competitor Research schedules are **off** (manual runs still work) — both depend on the unofficial scraper Binance blocks from GitHub's IPs, and competitor-scan had been filing dozens of empty issues. Close the old empty issues.

### Housekeeping

- **NEW:** `test/cards.test.mjs` (19), `test/research.test.mjs` (21), `test/news-opinion.test.mjs` (16) — suite is now **253 tests**. The e2e harness ships `cards.mjs`/`research.mjs` into its clones.
- **NEW:** workflows: `research-post.yml` (Tue/Fri short, first-Saturday article); `news-post.yml` gains the optional renderer install step (manual input can turn it off).
- **Docs:** README's media-desk section, PC-SETUP renderer note, `.env.example` research/card vars.
- **Not yet verified live:** DefiLlama/mempool.space/Wikipedia shapes on a real run (parsers are fixture-tested; first dry run will tell), card PNG upload to Square, real Telegram delivery of research approvals.

## v10.2 (maintenance: all three free AI models were dead, reasoning-model handling)

A real v10.1 run on GitHub confirmed it: **all three AI providers failed with HTTP 404**, so every post and news rewrite had been using the plain template fallback. The exact errors were Groq `model_not_found` (llama-3.3-70b-versatile), OpenRouter "unavailable for free", and Gemini "no longer available" (gemini-2.0-flash).

- **FIX (Groq):** `llama-3.3-70b-versatile` was retired on 2026-08-16. Default is now `openai/gpt-oss-120b` (Groq's recommended replacement). Set `GROQ_MODEL` to use another.
- **FIX (OpenRouter):** `meta-llama/llama-3.3-70b-instruct:free` is no longer free. Default is now `openrouter/free`, OpenRouter's Free Models Router, which picks a model that is free at that moment, so one model being retired can't break this provider again. It chooses a different model per request, so output style varies, but every reply still passes the same validators. Pin one with `OPENROUTER_MODEL` (or a paid slug if you have credit). *Correction:* an earlier draft of this release said the old OpenRouter model was "still listed"; that came from stale mirror pages and was wrong.
- **FIX (Gemini):** `gemini-2.0-flash` was shut down 2026-06-01 (and `gemini-2.5-flash` was scheduled for 2026-10-16). Default is now `gemini-3.8-flash`, the model Google's own 404 message names. Free-tier limits are not published per model; see your AI Studio rate-limit console. Fallback choice if it errors: `gemini-3.5-flash-lite`.
- **FIX (reasoning models):** `gpt-oss`, Gemini 3.x and several free OpenRouter models think before answering, and that hidden thinking counts against the output limit. At the old 800-token cap a reply could stop with `finish_reason: length` before writing anything. Groq `gpt-oss` now gets `reasoning_effort: "low"` and 2000 tokens, OpenRouter 2000, Gemini 3.x+ 4096. Gemini replies now join every visible text part and ignore thought parts instead of reading only the first part.
- **FIX (`scan.mjs`):** the comment-reply helper had the same dead models and a 100-token limit; it now uses the same defaults (and honours `GROQ_MODEL` / `OPENROUTER_MODEL`) with an 800-token limit.
- **NEW:** news posts now end with a short disclaimer line (default `Not financial advice.`) under the sources, matching the daily posts. Set `NEWS_DISCLAIMER` to your own text, or to `off` to remove it. It adds no cashtags or hashtags. (`news.mjs` and `post.mjs` must be updated together.)
- **NEW:** `SEC_USER_AGENT` (optional). The SEC asks automated clients to identify themselves; set e.g. `my-bot you@example.com` (sent to sec.gov only). A live dry run showed the SEC feed already works without it (1 item), so this is only needed if the SEC starts returning 403.
- **CHANGED:** `actions/github-script` v7 → v8 in five workflows (they only use `require('fs')`). `actions/checkout@v7` and `actions/setup-node@v7` were checked and are current.
- **VERIFIED LIVE (by a real dry run):** on GitHub Actions all eight news feeds fetch correctly, including the SEC (1 item) and Federal Reserve (4 items) feeds that v10.1 could not test; clustering and scoring produced sensible stories.
- **FIX (feeds on a home connection):** the same dry run on the Windows PC fetched only 2 of 8 feeds, and the log said just "fetch failed". Node hides the real reason inside `err.cause`, so the log now shows it (e.g. `fetch failed [UND_ERR_CONNECT_TIMEOUT]`, `timed out`, `HTTP 403`). A network-level failure is now retried once (1.5 s later, with a 10 s longer timeout); HTTP errors are not retried. New optional `NEWS_FETCH_TIMEOUT_SEC` (default 15) for slow links.
- **Tests:** 197 (new `test/providers.test.mjs`: defaults can't regress to the retired models, request shape for reasoning models, Gemini multi-part parsing, SEC user-agent scoping).
- **Not yet verified live:** the new models themselves (first dry run after upgrading will show), publishing to Binance Square, Telegram delivery, Ollama speed.

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
