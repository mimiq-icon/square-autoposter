# dry-run-all.ps1 — runs every part of the bot WITHOUT publishing anything.
# From the repo folder (PowerShell):   powershell -ExecutionPolicy Bypass -File .\dry-run-all.ps1
# Nothing is posted to Binance Square. Feeds, prices and AI are still really called,
# so it needs your internet and (for local AI) Ollama running.
$ErrorActionPreference = "Continue"
New-Item -ItemType Directory -Force logs | Out-Null

function Step([string]$name, [scriptblock]$run) {
  Write-Host "`n=== $name ===" -ForegroundColor Yellow
  & $run
  Write-Host "--- exit code: $LASTEXITCODE" -ForegroundColor DarkGray
}
function Mode([string]$name, [string]$mode, [hashtable]$extra = @{}) {
  Step $name {
    $env:DRY_RUN = "true"
    if ($mode) { $env:RUN_MODE = $mode } else { Remove-Item Env:RUN_MODE -ErrorAction SilentlyContinue }
    foreach ($k in $extra.Keys) { Set-Item "Env:$k" $extra[$k] }
    node post.mjs
    Remove-Item Env:RUN_MODE -ErrorAction SilentlyContinue
    foreach ($k in $extra.Keys) { Remove-Item "Env:$k" -ErrorAction SilentlyContinue }
  }
}

Step "1. Unit + end-to-end tests (all mocked)"   { node --test }
Step "2. Card previews -> card-previews\"        { node preview-cards.mjs }
Step "3. PC runner settings check"               { node local-runner.mjs --check }
Step "4. PC runner: one full news+alerts cycle"  { node local-runner.mjs --dry-run --once }

Mode "5. Education / research desk"  "research"
Mode "6. Top movers digest"          "top-movers-digest"
Mode "7. Daily post"                 ""
Mode "8. Weekly article: draft"      "weekly-draft"   @{ DRAFT_OUTPUT_FILE = "logs\weekly-draft.dry.json" }
Mode "9. Weekly article: publish"    "weekly-publish" @{ ARTICLE_INPUT_FILE = "logs\weekly-draft.dry.json" }

Write-Host "`nNot covered here: scan.mjs (trend/competitor/comments scans) needs a Linux tool at /tmp/bsq, so it only runs on GitHub." -ForegroundColor DarkYellow
Write-Host "Not covered: weekly-approve sends a real Telegram message; run it only when you want one." -ForegroundColor DarkYellow
