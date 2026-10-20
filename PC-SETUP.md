# Running the news bot on your PC

Your Windows 11 PC (i5-8365U, 8 GB RAM, no GPU) is plenty for this. The PC checks the news feeds every ~2.5 minutes and writes posts with a small local AI model. GitHub keeps running hourly in the background, so **the PC does not need to be on 24/7**; when it's off or asleep, GitHub carries on.

Before you start, you need these in the repo (upload the v10.2 files to GitHub and commit; v10.2 replaced the retired Groq and Gemini default models, see CHANGELOG.md): `post.mjs`, `news.mjs`, `news-sync.mjs`, `telegram.mjs`, `local-runner.mjs`, `start-news.bat`, `.env.example`, `.gitignore`, `.github/workflows/news-post.yml`.

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

Check that pushing works **without a password prompt** (the runner can't answer prompts):

```
git push --dry-run origin main
```

A browser sign-in window may appear the first time; sign in to GitHub once. You should end up seeing `Everything up-to-date`. If this fails, fix it first. Stay on the `main` branch.

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

## 6. Test it, then start it

```
node local-runner.mjs --check
node local-runner.mjs --dry-run --once
```

`--check` confirms your settings, git and Ollama. `--dry-run --once` runs one full cycle and prints the post it *would* publish without publishing anything. Read the output: each feed should show an item count (a feed marked FAILED is skipped; SEC and Federal Reserve are the two I could not test against live servers, so tell me if they fail). Quiet moments legitimately produce "No story is ready to post".

When it looks right, double-click **`start-news.bat`**. A window opens and stays open; it logs each cycle and also writes `logs\news.log`. Close the window to stop it.

## 7. Start automatically when you sign in

Settings are in **Task Scheduler** → Create Basic Task → name `Square news runner` → trigger **When I log on** → action **Start a program** → browse to `start-news.bat`. Or in PowerShell (edit the path):

```
schtasks /Create /TN "SquareNewsRunner" /SC ONLOGON /TR "\"C:\Users\YOU\square-autoposter\start-news.bat\"" /RL LIMITED /F
```

To keep it running while you're away: Settings → System → Power → Screen and sleep → when plugged in, put the device to sleep **Never**; and Control Panel → Power Options → "Choose what closing the lid does" → **Do nothing** when plugged in. Windows will still restart for updates now and then; the runner comes back when you sign in, and GitHub covers the gap.

## How the PC and GitHub avoid double-posting

Before publishing, each runner records a "claim" on the story in `news-state/posted.json` and pushes it. Git refuses the second push, so whoever loses the race sees the other's claim and moves on. Two further rules: a minimum gap between posts (`NEWS_MIN_GAP_MIN`, default 5 minutes) and a daily cap (`NEWS_MAX_PER_DAY`, default 12), both counted across both machines. If publishing fails, the claim is released and the story is retried.

If the PC can't reach GitHub when it starts a cycle, it **doesn't post** rather than risk a duplicate.

## Updating the code later

```
git checkout -- news-state/posted.json
git pull
```

(The first line discards only the local copy of the state file, which the runner re-downloads at the start of every cycle.)

## Troubleshooting

| You see | Meaning / fix |
|---|---|
| `Ollama not reachable` | Start Ollama from the Start menu. Until then posts use cloud AI or the plain-headline fallback. |
| `model "…" is not installed` | `ollama pull qwen2.5:3b` |
| `Could not read shared state from git` | No internet, or git can't sign in. Re-run `git push --dry-run origin main`. |
| `not a git clone` | You downloaded a zip. Use `git clone` (step 2). |
| `Standing down: last post was N min ago` | Normal; the minimum gap. |
| `Another runner pushed first … re-reading` | Normal; the PC and GitHub raced and the other won. |
| `No story is ready to post` | Normal; nothing new cleared the importance bar. Lower `NEWS_MIN_SCORE` for more posts. |
| `still waiting on approval` | A draft is waiting for your Telegram tap. |
| No Telegram message | Check the token and chat id, and that you sent the bot a message first. |
| A story you expected was never posted | Check `logs\news.log` for its score and reason. Sensitive single-outlet stories wait for a second outlet; stories that were rejected or timed out on Telegram are not offered again. |

## What you're trusting

The bot reports what the outlets report. A wrong story in a feed can become a wrong post. The checks (importance bar, two outlets for risky claims, fact-checker on rewrites, optional tap) reduce that; they don't make it zero. For the most control, use `NEWS_APPROVAL=all`.


## v10.2: what else the runner does now

- **Price alerts** are checked every cycle after the news check (log line `alerts ok in Ns`). With Telegram set up they ask for your tap first; add `ALERT_APPROVAL=off` to `.env` to auto-post, or `ALERTS_ENABLED=off` to switch them off.
- **A line in `.env` that starts with `#` is a comment and does nothing.** To turn a setting on, type it on a new line WITHOUT the `#`, for example `NEWS_APPROVAL=all`, then save. The first line of a run, `NEWS MODE (... approval all ...)`, shows what was actually loaded.
- New files must be in your clone: after uploading to GitHub run `git fetch origin` then `git reset --hard origin/main`.
