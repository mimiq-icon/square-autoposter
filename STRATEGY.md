# The Tape: strategy review (v11.9)

A review of the whole desk as a strategist, operator and quality reviewer would do it: what we have, what "better" means, what limits are real, and what is worth doing next. It is written from what the code and the dry runs showed, not from generic advice. Where the evidence is thin, it says so.

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
- **Network blind spots.** The build sandbox has no outbound access. Every live source and the Telegram preview have only ever run against mocks, so the first real dry runs are real evidence.

## 4. Where it stood, and what changed

| Area | Finding | Done |
|---|---|---|
| Voice | Closing questions, "not just X but Y", dash flourishes, "NFA/DYOR", a forced "Contrarian Question" every fifth daily post. | Shared voice linter in all five writers; plain disclaimers; question vibe removed. |
| Model order | The 3B local model ran first on the PC and wrote the flattest copy. | Cloud first, local model is the offline backup. |
| Alerts | Level alerts fired on cents (BNB $740.01 to $739.98). Hero number disagreed with the headline. | Clean-crossing rule; second price source; "lowest since" from real candles; line chart default. |
| Research | Failures logged as "fetch failed" and lost; the writer never saw the concept notes; one thin source could post. | Reasons, retries, concept notes in the facts, minimum independent sources. |
| Data and visuals | Data topics got a plain title card and appeared once a month. | Six new sources, six new topics, ranked-bar charts, a weekly data post (Friday). |

## 5. The ideas, ranked (impact, effort, risk)

**Do first (small, high value, needs no new code)**

1. **Make the GitHub hourly news workflow safe.** It posts live with no approval unless `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are saved as repo secrets. It is the one path where a plain-template headline post can go out unseen. Either add the two secrets (then it asks like the PC does) or disable it while the PC runner is the main engine. Highest risk-reduction per minute spent.
2. **Run a four-week format test by hand.** Each week note views and likes for each format (news card, alert, explainer, data post, article). The system cannot see them, you can. Keep what earns attention, cut what does not. This is the only way to know whether the new Friday data post beats an explainer.
3. **Watch the fallback rate.** After a week of dry runs, count how many posts used the template. A high rate means the linter or validators are stricter than the free models can satisfy; the log names the rule each time, so loosen that one rule, not all of them.

**Do next (moderate)**

4. **A market-breadth data topic.** The daily post already fetches the top 100 coins from CoinGecko. "How many of the top 100 are up, the biggest movers, dominance" as a ranked chart needs no new source and is the most "alpha-like" content per effort. Not built: wanted your call on whether it overlaps the daily post.
5. **A genuine second source for single-source topics.** 8 of 17 topics declare one source. Forcing Wikipedia onto them would only add generic text. A real independent data source per topic is better; add them one at a time, only when verified.
6. **A monthly provider health check.** One dry run a month, read the "Trying groq / openrouter / gemini" lines. Catches the next model retirement before it silently degrades every post.

**Not built, on purpose**

- **Primary-documentation sources (ethereum.org docs, BIPs, Mastering Bitcoin).** They are HTML pages with unverified structure and the build environment cannot fetch them. Parsers written blind would fail quietly. Stage 3's failure reporting would catch that, but it is still wasted work until someone can test them live. Do it when a live dry run is available.
- **Publisher photos and wire images.** Copyright, and upscaling does not fix it. The desk's own cards are the answer.
- **A "reviewer" AI pass.** Costs free-tier calls and adds another thing that can fail. The code checks are cheaper and stricter.
- **Predictions, price targets, trade calls.** Rejected by the validators and not worth the risk.
- **More formats before the current ones are measured.** The desk now has eight (news, alerts, daily, digest, weekly recap, explainer, data post, monthly article). Adding an eighth before step 2 above adds taps, not insight.

## 6. What to avoid (the failure modes seen in this project)

- **Scope growth without shipping.** The earlier "v12" overhaul was lost because it was never packaged. Every stage since ends in a tested zip.
- **Tests that only agree with themselves.** Several fixes started with a failing end-to-end run, not a unit test (a research topic that could never get its chart; a sample article rejected because a test changed its own number). Keep an end-to-end test for every new path.
- **Trusting a source's shape from memory.** The DefiLlama stablecoin `circulating` field is an object, not a number. Verify against the provider's docs, and let the parser say "the format may have changed" instead of posting nonsense.

## 7. The next 30 days

1. Week 1: apply v11.9 to GitHub; do ideas 1 and 3; run `dry-run-all.bat` on the PC and read the logs.
2. Weeks 1 to 4: idea 2, one line per post in a note.
3. Week 4: keep the formats that earned attention; decide on ideas 4 and 5 with real numbers.
