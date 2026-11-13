# Running the news bot on your PC

Your Windows 11 PC (i5-8365U, 8 GB RAM, no GPU) is plenty for this. The PC checks the news feeds every ~2.5 minutes and writes posts with a small local AI model. GitHub keeps running hourly in the background, so **the PC does not need to be on 24/7**; when it's off or asleep, GitHub carries on.

Before you start, you need these in the repo (clone the repo or commit from the PC with `save-and-push.bat` — do not upload a zip through the GitHub web page; see CHANGELOG.md for what each version added): `post.mjs`, `news.mjs`, `cards.mjs`, `research.mjs`, `alerts.mjs`, `article.mjs`, `style.mjs`, `news-sync.mjs`, `telegram.mjs`, `local-runner.mjs`, `check-sync.mjs`, `run-mode.mjs`, `make-avatar.mjs`, `preview-cards.mjs`, `brand/` (logo and bundled fonts), `test-support/`, `start-news.bat`, `check-sync.bat`, `save-and-push.bat`, `score-post.bat`, `score-post.ps1`, `dry-run-all.bat`, `dry-run-all.ps1`, `scorecard.csv`, `.env.example`, `.gitignore`, and the `.github/workflows/` folder.

The PC runner also checks prices for **alerts** ("Bitcoin falls below $83,000") in the same cycle, and every alert can wait for your Telegram tap (set the `TELEGRAM_*` values in `.env`; `ALERT_APPROVAL=off` posts them automatically). If a coin just moved sharply, that cycle takes a few seconds longer.

## 1. Install three programs

| Program | Get it from | Notes |
|---|---|---|
| Node.js (LTS) | nodejs.org | Version 18 or newer. |
| Git for Windows | git-scm.com | Accept the defaults (this includes the Git Credential Manager that remembers your GitHub login). |
| Ollama | ollama.com | Runs the local AI model. It starts with Windows and listens only on your own machine (`localhost`), so nothing is exposed to the internet. |

Close and reopen any terminal afterwards so the new programs are found.

## 2. Get the code (clone, don't download the zip)

Open **PowerShell** and run:

```
cd $HOME
git clone https://github.com/mimiq-icon/square-autoposter.git
cd square-autoposter
```

It has to be a real clone: the PC and GitHub avoid double-posting by sharing a file through git, which doesn't work from a zip download.

Check that talking to GitHub works **without a password prompt** (the runner can't answer prompts):

```
git fetch origin
node check-sync.mjs
```

A browser sign-in window may appear the first time; sign in to GitHub once. `check-sync` should report that the folder is up to date (or behind, which is normal — the bot commits a claim to `main` every time it posts).

Do **not** test with `git push` on a fresh clone: it will be rejected as non-fast-forward, because the bot's own claim commits make the remote move. That is expected, not a broken login. To publish your own changes, double-click `save-and-push.bat`, which fetches, rebases and pushes in that order. **Never `git push --force`** — the claim history on `main` is what stops the bot from reposting stories it already published.

## 3. Download the AI model

```
ollama pull qwen2.5:3b
ollama run qwen2.5:3b "Say hi in five words"
```

Type `/bye` to leave. `qwen2.5:3b` is a good fit for 8 GB of RAM without a GPU (about 2 GB for the model). Avoid "thinking" models (qwen3, deepseek-r1): on a CPU they take minutes per answer. `llama3.2:3b` is a fine alternative.

Speed: I haven't measured this on your laptop. A CPU-only 3B model typically produces a few words per second, so one short post should take somewhere between several seconds and a minute. The runner allows up to 4 minutes before giving up on the local model and trying a cloud one. Ollama unloads an idle model after 5 minutes, so the first post after a quiet spell is slower. To keep it loaded for an hour, set a user environment variable `OLLAMA_KEEP_ALIVE` to `1h` (Windows search → "Edit environment variables for your account"), then quit and reopen Ollama from the tray.

The model only **rewrites a headline**. Every fact in a post comes from the news feeds, and a checker throws away any rewrite that adds a number, name or coin that wasn't in the source (then the cleaned original headline is used instead).

## 4. Fill in your settings

```
copy .env.example .env
notepad .env
```

- `BINANCE_SQUARE_OPENAPI_KEY` — the same key you saved as a GitHub secret.
- `OLLAMA_MODEL=qwen2.5:3b` — already filled in.
- `GROQ_API_KEY` etc. — optional cloud backups, used if the local model is down or its answer fails the checker. Leave blank if you don't have them. Their default models are set in the code (Groq `openai/gpt-oss-120b`, Gemini `gemini-3.8-flash`, OpenRouter `openrouter/free`); only add `GROQ_MODEL=` or `GEMINI_MODEL=` lines here if a provider reports that a model no longer exists.
- `SEC_USER_AGENT` — optional, a name plus contact such as `my-bot you@example.com`, so the SEC will serve its press-release feed.
- Telegram (optional, recommended): see step 5.

`.env` is git-ignored, so it never gets uploaded. Don't paste its contents into chats or issues. If a key is ever exposed, regenerate it.

## 5. Telegram approval (optional, 2 minutes on your phone)

With this, risky stories (hacks, thefts, arrests, bankruptcies, depegs, bans) arrive on your phone as the exact post with **✅ Post / ❌ Skip** buttons. Nothing is published without your tap; no tap within 8 minutes means it's dropped.

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts → copy the token into `TELEGRAM_BOT_TOKEN`.
2. Send your new bot any message (e.g. "hi").
3. Open `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` in a browser and copy the number after `"chat":{"id":` into `TELEGRAM_CHAT_ID`.

Want to approve *every* post? Add `NEWS_APPROVAL=all`. Without Telegram, risky stories are only posted once two outlets (or an official source like the SEC) carry them.

## 6. One-time install for the news cards (v11)

Every news post ships with a branded card image. The card is drawn in code (no design tools); one small native library turns the SVG into a PNG for upload. In the repo folder:

```
npm install --no-save @resvg/resvg-js
```

That's it — it installs into `node_modules` (git-ignored) and the bot picks it up automatically. Without it, posts still go out, just without the image (the log says so). Repeat this once after a fresh clone.

## 7. Test it, then start it

```
node local-runner.mjs --check
node local-runner.mjs --dry-run --once
```

`--check` confirms your settings, git and Ollama. `--dry-run --once` runs one full cycle and prints the post it *would* publish without publishing anything. Read the output: each feed should show an item count (a feed marked FAILED is skipped; SEC and Federal Reserve are the two I could not test against live servers, so tell me if they fail). Quiet moments legitimately produce "No story is ready to post".

When it looks right, double-click **`start-news.bat`**. A window opens and stays open; it logs each cycle and also writes `logs\news.log`. Close the window to stop it.

## 8. Start automatically when you sign in

Settings are in **Task Scheduler** → Create Basic Task → name `Square news runner` → trigger **When I log on** → action **Start a program** → browse to `start-news.bat`. Or in PowerShell (edit the path):

```
schtasks /Create /TN "SquareNewsRunner" /SC ONLOGON /TR "\"C:\Users\YOU\square-autoposter\start-news.bat\"" /RL LIMITED /F
```

To keep it running while you're away: Settings → System → Power → Screen and sleep → when plugged in, put the device to sleep **Never**; and Control Panel → Power Options → "Choose what closing the lid does" → **Do nothing** when plugged in. Windows will still restart for updates now and then; the runner comes back when you sign in, and GitHub covers the gap.

## How the PC and GitHub avoid double-posting

Before publishing, each runner records a "claim" on the story in `news-state/posted.json` and pushes it. Git refuses the second push, so whoever loses the race sees the other's claim and moves on. Two further rules: a minimum gap between posts (`NEWS_MIN_GAP_MIN`, default 5 minutes) and a daily cap (`NEWS_MAX_PER_DAY`, default 40; set it lower in `.env` if you want fewer posts), both counted across both machines. If publishing fails, the claim is released and the story is retried.

If the PC can't reach GitHub when it starts a cycle, it **doesn't post** rather than risk a duplicate.

## Is this PC up to date with GitHub?

Double-click **`save-and-push.bat`** to commit and push this folder's changes. Prefer it to uploading a zip through GitHub's web page: the web uploader flattens folders, which is how 22 duplicate test files once landed in the repo root and broke the suite.

Double-click **`check-sync.bat`** (or run `node check-sync.mjs`). It fetches GitHub's `main` and compares the *code* (the bot's own `news-state/` and `logs/` files are ignored because they change all day by design). You get one of:

- `Up to date` - identical to GitHub. Nothing to do.
- `BEHIND` - GitHub has newer commits (normal: the bot commits a claim every time it posts). It prints two fixes — `git pull --rebase origin main`, which keeps your own commits, and `git reset --hard origin/main`, which discards them. Use the rebase unless you are certain nothing here is unpublished.
- `MODIFIED` / `AHEAD` / `DIVERGED` - it lists the files and says what to do.

The runner prints the same line every time it starts (`code: ...`).

## The weekly scorecard (`scorecard.csv`)

Once posts are going out, add one row per post: date, format, title, views, likes, comments, follows, notes. The bot cannot see views or likes, so this file is the only way a format decision ever gets made on evidence rather than taste. After about 20 rows, keep the formats that earn attention and cut or merge the rest.

Double-click **`score-post.bat`** to do it: it prompts for each field (format is a number, 1-8), appends the row, and tells you how many rows you have. About 15 seconds per post. It cannot read your dashboard for you — that part is unavoidably manual.

## Dry-run EVERYTHING on the PC

Double-click **`dry-run-all.bat`** (or `powershell -ExecutionPolicy Bypass -File .\dry-run-all.ps1`). It runs every part of the bot as a dry run: nothing is posted, nothing is sent to Telegram, nothing is saved to GitHub. It loads your `.env`, so the AI, Ollama and Telegram settings are the real ones. It starts with the sync check, runs the tests, then the news + alert cycle, an education post, a research article, the digest, the daily post and the weekly article, and finishes with an OK/PROBLEM table, the card pictures it made (`logs\` and `card-previews\`) and a full log (`logs\dry-run-all-*.txt`). Add `-AllTopics` to also dry-run every education/research topic.

To dry-run just one thing:

```
node run-mode.mjs list                       (modes + research topic ids)
node run-mode.mjs news
node run-mode.mjs alerts
node run-mode.mjs research RESEARCH_TOPIC=what-is-a-dex RESEARCH_FORCE=true
node run-mode.mjs weekly-approve
```

It is a dry run unless you add `--live`.

## Updating the code later

Do not copy a zip over this folder. Overwriting files is how the repo ended up with duplicate tests and a red suite. Two safe flows:

**You have changes here to publish** (the normal case): double-click **`save-and-push.bat`**. It commits, then `git pull --rebase`, then pushes. If the rebase hits a conflict it stops and tells you what to do; nothing is forced.

**You only need to catch up with GitHub** (someone pushed code, or you want the bot's latest claims):

```
cd C:\Users\augus\square-autoposter
git fetch origin
git pull --rebase origin main
node check-sync.mjs
```

`--rebase` replays your own commits on top instead of merging, and it never discards them.

`git reset --hard origin/main` still works, but it **throws away every commit this folder has that GitHub does not**. Only use it when you are certain nothing here is unpublished, and never as a reflex after a rejected push.

If a push is refused because it touches `.github/workflows/`, the stored GitHub login is missing the `workflow` scope. Run `gh auth login` (or re-authorise Git Credential Manager) and choose the workflow scope; then push again. Do not work around it by re-uploading files in the web page.

`git status` before a commit should list code, `brand/`, `.github/workflows/` and the bot's own `news-state/` files (those are meant to be committed — the claim lock lives there). It should never list `.env`, `logs/`, `card-previews/` or `weekly-draft.json`; those are gitignored.

## Troubleshooting

| You see | Meaning / fix |
|---|---|
| `Ollama not reachable` | Start Ollama from the Start menu. Until then posts use cloud AI or the plain-headline fallback. |
| `model "…" is not installed` | `ollama pull qwen2.5:3b` |
| `Could not read shared state from git` | No internet, or git can't sign in. Re-run `git fetch origin` and check it completes without asking for a password. |
| `not a git clone` | You downloaded a zip. Use `git clone` (step 2). |
| `Standing down: last post was N min ago` | Normal; the minimum gap. |
| `Another runner pushed first … re-reading` | Normal; the PC and GitHub raced and the other won. |
| `No story is ready to post` | Normal; nothing new cleared the importance bar. Lower `NEWS_MIN_SCORE` for more posts. |
| `still waiting on approval` | A draft is waiting for your Telegram tap. |
| No Telegram message | Check the token and chat id, and that you sent the bot a message first. |
| A story you expected was never posted | Check `logs\news.log` for its score and reason. Sensitive single-outlet stories wait for a second outlet; stories that were rejected or timed out on Telegram are not offered again. |

## What you're trusting

The bot reports what the outlets report. A wrong story in a feed can become a wrong post. The checks (importance bar, two outlets for risky claims, fact-checker on rewrites, optional tap) reduce that; they don't make it zero. For the most control, use `NEWS_APPROVAL=all`.
