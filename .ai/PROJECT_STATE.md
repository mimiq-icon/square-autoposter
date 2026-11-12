# The Tape (square-autoposter): project state

**Version:** v11.10 (operating-loop pass)  |  **Tests:** 521/521 passing (`node --test`; 17 skip without `@resvg/resvg-js`)  |  **Pushed:** yes (`bdec584`, then this state update)

## What it is
Binance Square auto-poster: news, price alerts, research/education, weekly AI article. Telegram approval flow, branded image cards (SVG -> PNG), git-shared state in `news-state/`.

## Source of truth
GitHub `main`. Commit local changes from the PC with `save-and-push.bat`; do not upload zips through the GitHub web UI (it flattens folders and has broken the suite twice).

## Done this pass (v11.10)
- `news-post.yml` + `alert-post.yml` now pass `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` (the secrets existed but the job could not see them, so the hourly runner posted sensitive stories without asking).
- Research has a mechanical fallback: `buildResearchTemplateCopies()` (concept notes for education, fact text for data topics), validated candidate by candidate; `provider=template`. Article drops the duplicate "idea, step by step" section and a notes-only post credits no source.
- `what-is-tvl` pointed at the live "Decentralized finance" Wikipedia article; `what-is-a-layer-2` is now `notesOnly` (both old wiki titles 404 permanently).
- Deleted 22 duplicate root `*.test.mjs` + stray `test/tests.yml`; added `check-sync.mjs` / `run-mode.mjs` to the test workflow paths.
- Untracked `card-previews/` (16 files) and `weekly-draft.json`; added both to `.gitignore`.
- New `save-and-push.bat` and `scorecard.csv`.
- Docs: README (521 tests, research fallback), CHANGELOG v11.10, PC-SETUP file list.

## Next (ranked, from STRATEGY.md + the v11.10 review)
1. **Score the first week.** `scorecard.csv`: one row per post (date, format, title, views, likes, comments, follows, notes). After ~20 rows, keep the two formats that earn attention and cut or merge the rest.
2. **Fallback rate.** After a week of runs, count `Using the data template` / `Using template fallback` lines. Loosen only the rule the log names, never all of them.
3. **Confirm the live path once.** Trigger `news-post.yml` manually with dry_run off on a quiet hour and confirm the Telegram tap arrives from the GitHub runner too (the PC `.env` needs the same two values).
4. Optional, after the above: market-breadth data topic; real second sources for single-source topics; monthly provider health check.

## Open items (yours)
1. Push is DONE (v11.10 is on `origin/main`). If a push is rejected again: the bot commits a claim to `main` on every story, so `save-and-push.bat` now does `git pull --rebase` first. Never force.
2. Close the ~70 empty Competitor Research issues by hand.
3. On the PC add `NEWS_FEEDS_OFF=CryptoSlate` to `.env` (HTTP 403 there), and make sure `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` are in `.env` too (the PC reads `.env`, not repo secrets).
4. Confirm the GitHub runner asks for approval: trigger `news-post.yml` once with dry_run off and check the tap arrives.
5. Decide the goal: audience growth vs. a reliable personal wire. The next month differs a lot between the two.

## Resume
Say "Continue", read this file and `git log -5`, then start the next unchecked item.
