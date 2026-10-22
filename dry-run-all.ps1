# dry-run-all.ps1  (v11.3)
# Runs EVERY part of the bot as a DRY RUN: nothing is posted to Binance Square,
# nothing is sent to Telegram, nothing is saved to GitHub. Feeds, prices and the
# AI are really called, so it needs internet (and Ollama running for the local AI).
#
# From the repo folder:   powershell -ExecutionPolicy Bypass -File .\dry-run-all.ps1
# or just double-click dry-run-all.bat
#   -AllTopics   also dry-run EVERY education/research topic (slower: one AI call each)
#   -SkipTests   skip the unit/end-to-end test suite
# Your .env is loaded automatically (node run-mode.mjs does it), so the AI providers,
# Ollama and Telegram settings are the real ones.
param([switch]$AllTopics, [switch]$SkipTests)
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force logs | Out-Null
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$transcript = "logs\dry-run-all-$stamp.txt"
Start-Transcript -Path $transcript | Out-Null
$results = New-Object System.Collections.ArrayList

function Run([string]$name, [scriptblock]$block, [string]$problemText = "PROBLEM") {
  Write-Host "`n=== $name ===" -ForegroundColor Yellow
  $global:LASTEXITCODE = 0
  & $block
  $code = $global:LASTEXITCODE
  [void]$results.Add([pscustomobject]@{ Step = $name; Exit = $code; Result = $(if ($code -eq 0) { "OK" } else { $problemText }) })
}

Run "0. Is this PC's code the same as GitHub's?"  { node check-sync.mjs } "ATTENTION"
if (-not $SkipTests) { Run "1. Unit + end-to-end tests (all mocked)" { node --test } }
Run "2. Settings check (.env, Ollama, Telegram, git)"   { node local-runner.mjs --check }
Run "3. Card design previews -> card-previews\"         { node preview-cards.mjs }
Run "4. PC runner: one full news + price-alert cycle"   { node local-runner.mjs --dry-run --once }
Run "5. Education short post (next topic in rotation)"  { node run-mode.mjs research RESEARCH_MODE=short RESEARCH_FORCE=true }
Run "6. Research article (monthly format)"              { node run-mode.mjs research RESEARCH_MODE=article RESEARCH_FORCE=true }

if ($AllTopics) {
  $ids = node -e "import('./research.mjs').then(m => console.log(m.RESEARCH_TOPICS.map(t => t.id).join(' ')))"
  foreach ($id in ($ids -split " " | Where-Object { $_ })) {
    Run "5b. Research topic: $id" { node run-mode.mjs research RESEARCH_TOPIC=$id RESEARCH_FORCE=true }
  }
}

Run "7. Top movers digest"                              { node run-mode.mjs digest }
Run "8. Daily market post"                              { node run-mode.mjs daily }
Run "9. Weekly article (AI-written, Telegram flow)"     { node run-mode.mjs weekly-approve }
Run "10. Weekly article: old draft step"               { node run-mode.mjs weekly-draft DRAFT_OUTPUT_FILE=logs\weekly-draft.dry.json }
Run "11. Weekly article: old publish step"             { node run-mode.mjs weekly-publish ARTICLE_INPUT_FILE=logs\weekly-draft.dry.json }

Write-Host "`n==================== SUMMARY ====================" -ForegroundColor Cyan
$results | Format-Table Step, Exit, Result -AutoSize | Out-String | Write-Host
$bad = @($results | Where-Object { $_.Result -ne "OK" })
$pics = @(Get-ChildItem logs, card-previews -Filter *.png -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt (Get-Date).AddMinutes(-60) })
if ($bad.Count -eq 0) { Write-Host "Everything ran. Nothing was posted." -ForegroundColor Green }
else { Write-Host ("{0} step(s) need a look (see above)." -f $bad.Count) -ForegroundColor Red }
Write-Host ("Card/slide pictures made in the last hour: {0}  (folders: logs\ and card-previews\)" -f $pics.Count)
Write-Host "Full log of this run: $transcript"
Write-Host "Not covered here: scan.mjs (trend/competitor/comment scans need a Linux tool, so they only run on GitHub)." -ForegroundColor DarkYellow
Stop-Transcript | Out-Null
try { Invoke-Item logs } catch { }
