@echo off
rem score-report.bat - what earned views, by format, and the ask-vs-no-ask test.
cd /d "%~dp0"
set /p SINCE=First date DAILY_CTA=alternate was in force (YYYY-MM-DD, blank to skip that test): 
if "%SINCE%"=="" (node score-report.mjs) else (node score-report.mjs --alt-since %SINCE%)
echo.
pause
