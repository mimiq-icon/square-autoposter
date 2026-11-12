# The Tape (square-autoposter): project state

**Version:** v11.9 (all planned stages done)  |  **Tests:** 518/518 passing (`node --test`, with `@resvg/resvg-js` installed)

## What it is
Binance Square auto-poster: news, price alerts, research/education, weekly AI article. Telegram approval flow, branded image cards (SVG -> PNG), git-shared state in `news-state/`.

## Source of truth
GitHub `main` (square-autoposter). `the-tape-v11_3.zip` is OLDER (v11.3). The `square-autoposter-main` snapshot was v11.4.

## Done this session (v11.4.1)
- Restored full `.env.example` (GitHub copy was stale, NEWS_MAX_PER_DAY said 12, real default 40)
- Removed stray `test/tests.yml`; re-ignored `card-previews/`
- News card with chart: starts higher, taller (no empty band)
- PC-SETUP.md file list updated
- CHANGELOG v11.4.1 entry
- `NEWS_FEEDS_OFF=CryptoSlate` setting (feed 403s on the PC) + test

## From the shared conversation (read via PDF; it covers v10.1 -> v11.3)
Settled: Groq/Gemini/OpenRouter default models replaced; Telegram approval (needs `NEWS_APPROVAL` uncommented); news cap 40/day; disclaimer rotation; alerts; AI weekly article via Telegram; research/education desk; card previews before approval; The Tape branding; check-sync + dry-run-all.
Decisions to keep: no re-uploading publishers' photos (copyright); AI writes only from validated facts, template fallback; competitor/trend scans are manual-only.

## Rebuild plan (the lost "v12"; user said: do it all yourself, in stages, one zip per stage)
- [x] **Stage 1 (v11.5) writing quality:** `style.mjs` linter, shared style guide in all 5 writers, no closing questions, plain disclaimers, cloud-first AI order, name-check fixes.
- [x] **Stage 2 (v11.6) alerts:** clean-crossing rule (`ALERT_LEVEL_MARGIN_PCT`), CoinGecko second-source check before claiming, "lowest since" context from hourly candles, glowing line default (`ALERT_CHART_STYLE=candles` opt-in), card hero matches headline.
- [x] **Stage 3 (v11.7) research reliability:** per-source failure reasons + attempts in the log and Job Summary, retries (`RESEARCH_RETRIES`), unusable answers reported, concept notes always in the facts, minimum independent sources (`RESEARCH_MIN_SOURCES`), parallel fetch. Note: only 3 of 11 topics declare 2+ sources; Stage 4 adds sources/topics so the minimum bites more.
- [x] **Stage 4a (v11.8) data + charts:** 6 new sources (DefiLlama stablecoins/chains/fees; mempool difficulty/height/pools), computed Bitcoin supply, 6 new topics (17 total), `buildRankedBarsSvg`, chart of the topic's own numbers as the research image.
- [x] **Stage 4b (v11.9) strategy pass:** `STRATEGY.md` (read it first), Friday short data post (`RESEARCH_DATA_DAY`), primary-documentation sources deliberately not built (unverifiable HTML).

## Next (from STRATEGY.md section 5)
1. Make the GitHub hourly news workflow ask for approval (add TELEGRAM secrets) or disable it.
2. Four-week hand-tracked format test (views/likes per format).
3. After a week of dry runs, check the template-fallback rate; loosen only the rule the log names.
4. Optional: market-breadth data topic from the CoinGecko data the daily post already fetches; real second sources for the 8 single-source topics; monthly provider health check.

## Open items (yours)
1. Push this tree to GitHub (no push access in chat). Keep GitHub's `news-state/`. Then on the PC: `node check-sync.mjs`.
2. GitHub `news-post.yml` still runs hourly and posts live; needs TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID as repo secrets for approval. Pause: Actions -> Breaking News Post -> ... -> Disable workflow.
3. ~70 open issues are mostly empty Competitor Research issues; close by hand.
4. On the PC add `NEWS_FEEDS_OFF=CryptoSlate` to `.env` (HTTP 403 there).
5. Run `dry-run-all.bat` on the PC and look at the post text: the lint is new, so watch for posts falling back to the plain template too often (the log says why).

## Resume
Say "Continue", read this file and `git log -5`, then start the next unchecked stage.
