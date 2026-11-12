@echo off
REM save-and-push.bat - commit this folder and push it to GitHub.
REM
REM Use this instead of uploading a zip through the GitHub web page. Uploading
REM a zip flattens the folder, which is how 22 duplicate test files ended up in
REM the repo root and turned the whole test suite red in CI.
REM
REM .env, logs\, .cache\, card-previews\ and weekly-draft.json are gitignored,
REM so they are never committed. Everything else (code, tests, docs and the
REM news-state files the bot itself maintains) is.
setlocal
cd /d "%~dp0"

echo.
echo === Changes that will be committed ===
git status --short
echo.

git add -A
git diff --cached --quiet
if errorlevel 1 goto commit
echo Nothing to commit - the folder already matches the last commit.
goto push

:commit
set /p MSG=Commit message (blank = "sync: <date time>"): 
if "%MSG%"=="" set MSG=sync: %DATE% %TIME%
git commit -m "%MSG%"
if errorlevel 1 goto fail

:push
git push origin main
if errorlevel 1 goto fail
echo.
echo Pushed. The GitHub test workflow should now run and go green.
pause
exit /b 0

:fail
echo.
echo Something went wrong above. Nothing was forced; fix the message and rerun.
pause
exit /b 1
