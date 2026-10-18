@echo off
rem Starts the news runner and restarts it if it ever exits.
rem Close this window (or press Ctrl+C twice) to stop.
title Square news runner
cd /d "%~dp0"
:loop
node local-runner.mjs
echo.
echo Runner exited (code %errorlevel%). Restarting in 30 seconds... (close this window to stop)
timeout /t 30 /nobreak >nul
goto loop
