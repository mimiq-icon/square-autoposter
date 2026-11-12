# The Tape: strategy review (v11.10)

A review of the whole desk as a strategist, operator and quality reviewer would do it: what we have, what "better" means, what limits are real, and what is worth doing next. It is written from what the code and the dry runs showed, not from generic advice. Where the evidence is thin, it says so.

**v11.10 update.** This pass closed the top risk (the GitHub runner that could not ask for approval), added a fallback so the research desk cannot go dark, and fixed the defects the dry runs exposed. It also started the measurement loop — but only started it: `scorecard.csv` exists and is empty, so every format judgement below is still unevidenced. What changed since v11.9 is in section 4; the ranked list in section 5 now carries status.

## 1. What this is

An automated Binance Square desk, "The Tape": breaking news, price alerts, a daily market post, short education explainers, a weekly data post, a monthly long-form article and a weekly recap. One person approves everything on Telegram. No budget: free API tiers, free GitHub Actions minutes, one Windows PC.

## 2. What "better" means (the success test)

1. **Reads like a person who covers markets wrote it.** Plain, specific, sourced, no filler and no engagement bait. Measured by the share of posts that go out as written by the model rather than falling back to the plain template (the log says why each one fell back).
2. **Never wrong in public.** One wrong "BREAKING" post costs more than ten missed stories. Measured by held alerts, rejected copy and sources that disagree.
3. **Recognisable.** The same look on every image (The Tape's yellow T, dark card), a chart where there are numbers.
4. **Survives free tiers.** It must keep working when a free model is retired, a feed blocks the PC, or the sandbox resets.

## 3. Real limits (these decide what is worth building)

- **Free credits and free tiers.** Every extra model call costs. So no second "reviewer" model pass; quality comes from cheap code checks (the voice linter, the grounding validators) that cost nothing.
- **Free model churn.** Groq, Gemini and OpenRouter each retired a default model within months. The provider list is the most fragile part of the system.
- **Binance Square limits.** 100 API posts and 400 image uploads a day; the news default is 40. Not a constraint at the current volume.
- **Human approval is the throughput limit.** Nothing publishes without a tap (research waits up to 120 minutes by default). More formats means more taps.
- **No analytics access.** The system cannot see views or likes, so it cannot learn what works on its own.
- **Network blind spots (partly resolved).** The original build sandbox had no outbound access, so every source was written against mocks. Live dry runs now happen on the PC and have since exercised the feeds, DefiLlama, mempool.space and Wikipedia for real. That immediately found two dead Wikipedia titles (section 4) that mocks could never have caught — a reminder that the remaining fixtures still only prove shape, not liveness.

## 4. Where it stood, and what changed

| Area | Finding | Done |
|---|---|---|
| Voice | Closing questions, "not just X but Y", dash flourishes, "NFA/DYOR", a forced "Contrarian Question" every fifth daily post. | Shared voice linter in all five writers; plain disclaimers; question vibe removed. |
| Model order | The 3B local model ran first on the PC and wrote the flattest copy. | Cloud first, local model is the offline backup. |
| Alerts | Level alerts fired on cents (BNB $740.01 to $739.98). Hero number disagreed with the headline. | Clean-crossing rule; second price source; "lowest since" from real candles; line chart default. |
| Research | Failures logged as "fetch failed" and lost; the writer never saw the concept notes; one thin source could post. | Reasons, retries, concept notes in the facts, minimum independent sources. |
| Data and visuals | Data topics got a plain title card and appeared once a month. | Six new sources, six new topics, ranked-bar charts, a weekly data post (Friday). |
| Live path (v11.10) | The repo secrets existed, but `news-post.yml` never passed them to the job, so the hourly runner could not see Telegram and posted sensitive stories without the tap this document assumed. | Both workflows pass the two values; `NEWS_APPROVAL` therefore defaults to `sensitive` on GitHub as well as on the PC. |
| Research durability (v11.10) | When no AI answer validated, the desk skipped the topic entirely — so a free-tier outage silently stopped the whole education line. | Mechanical fallback copy from the vetted concept notes (education) or the fetched fact text (data topics), validated candidate by candidate. |
| Research liveness (v11.10) | Two topics pointed at Wikipedia titles that do not exist (`Total value locked`, `Layer 2 (blockchain)`), so they failed their source minimum on every run, forever. | TVL now uses the live `Decentralized finance` article; layer 2 is an explicit concept-notes-only explainer. |
| Delivery (v11.10) | A zip uploaded through the GitHub web UI flattened the folder: 22 duplicate test files in the repo root turned the suite red (42 failures, 0 real), and tracked `card-previews/` made `check-sync` cry wolf after every dry run. | Duplicates and the stray `test/tests.yml` removed; `card-previews/` and `weekly-draft.json` untracked and ignored; `save-and-push.bat` replaces zip uploads and pull-rebases first, because the bot commits claims to `main` itself. |

## 5. The ideas, ranked (impact, effort, risk)

**Do first (small, high value, needs no new code)**

1. ~~**Make the GitHub hourly news workflow safe.**~~ **Done in v11.10.** The secrets existed; the workflow was not passing them to the job, so the runner still posted unasked. Both values are now passed. Left to confirm by hand: one manual `news-post.yml` run should produce a Telegram tap from the GitHub runner, not just from the PC.
2. **Run a four-week format test by hand.** Each week note views and likes for each format (news card, alert, explainer, data post, article). The system cannot see them, you can. Keep what earns attention, cut what does not. This is the only way to know whether the new Friday data post beats an explainer.
3. **Watch the fallback rate.** Every run's Job Summary already says `Written by: AI (provider)` or `template fallback`, and the log names the rule that rejected each attempt. A high rate means the linter or validators are stricter than the free models can satisfy; loosen that one rule, not all of them. `scorecard.csv` (new in v11.10) is where the format numbers go.

**Do next (moderate)**

4. **A market-breadth data topic.** The daily post already fetches the top 100 coins from CoinGecko. "How many of the top 100 are up, the biggest movers, dominance" as a ranked chart needs no new source and is the most "alpha-like" content per effort. Not built: wanted your call on whether it overlaps the daily post.
5. **A genuine second source for single-source topics.** 10 of the 17 topics still rest on a single independent source, and one (`what-is-a-layer-2`) is an explicit concept-notes-only explainer. Forcing Wikipedia onto them would only add generic text. A real independent data source per topic is better; add them one at a time, only when verified. v11.10 is the cautionary tale: two topics pointed at Wikipedia titles that return 404, and nothing noticed for weeks because the mocks always answered.
6. **A monthly provider health check.** One dry run a month, read the "Trying groq / openrouter / gemini" lines. Catches the next model retirement before it silently degrades every post.

**Not built, on purpose**

- **Primary-documentation sources (ethereum.org docs, BIPs, Mastering Bitcoin).** HTML pages with unverified structure. The original build environment could not fetch them, so parsers would have been written blind; a live run from the PC can now fetch them, so this is unblocked — it needs one verified parse against the real page before it is worth writing.
- **Publisher photos and wire images.** Copyright, and upscaling does not fix it. The desk's own cards are the answer.
- **A "reviewer" AI pass.** Costs free-tier calls and adds another thing that can fail. The code checks are cheaper and stricter.
- **Predictions, price targets, trade calls.** Rejected by the validators and not worth the risk.
- **More formats before the current ones are measured.** The desk has eight (news, alerts, daily, digest, weekly recap, explainer, data post, monthly article). Adding a ninth before step 2 above adds taps, not insight.

## 6. What to avoid (the failure modes seen in this project)

- **Scope growth without shipping.** The earlier "v12" overhaul was lost because it was never packaged. Every stage since ends in a tested zip.
- **Tests that only agree with themselves.** Several fixes started with a failing end-to-end run, not a unit test (a research topic that could never get its chart; a sample article rejected because a test changed its own number). Keep an end-to-end test for every new path.
- **Shipping through the GitHub web uploader.** Every "Add files via upload" commit since v11.4 was an opaque snapshot, and one of them flattened the folder and broke the suite. Commit from the PC with `save-and-push.bat`; a plain `git push` will be rejected (the bot commits claims to `main`), so pull-rebase first and never force.
- **Trusting a source's shape from memory.** The DefiLlama stablecoin `circulating` field is an object, not a number. Verify against the provider's docs, and let the parser say "the format may have changed" instead of posting nonsense.

## 7. The next 30 days

1. Week 1: confirm one manual `news-post.yml` run asks on Telegram; put the two `TELEGRAM_*` values in the PC's `.env`; run `dry-run-all.bat` and read the fallback lines.
2. Weeks 1 to 4: idea 2 — one row per post in `scorecard.csv` (format, views, likes, comments, follows).
3. Week 4: keep the two formats that earned attention and cut or merge the rest; decide on ideas 4 and 5 with real numbers.
4. Any time: fix forward on the PC and `save-and-push.bat`, never a zip.
