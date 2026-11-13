@echo off
REM score-post.bat - add one row to scorecard.csv (prompts for the numbers).
REM The bot cannot read views or likes, so this is the only way format
REM decisions get made on evidence. About 15 seconds per post.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0score-post.ps1"
pause
