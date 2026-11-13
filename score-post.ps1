# score-post.ps1 - add one row to scorecard.csv, with prompts.
#
# The bot cannot see views or likes, so this is the only way the format
# decisions ever get made on evidence. Run it once per post; it takes about
# 15 seconds. Start it with score-post.bat (double-click).
#
# Columns: date,format,title,views,likes,comments,follows,notes

$ErrorActionPreference = "Stop"
$csv = Join-Path $PSScriptRoot "scorecard.csv"
$header = "date,format,title,views,likes,comments,follows,notes"

if (-not (Test-Path $csv)) {
    Set-Content -Path $csv -Value $header -Encoding UTF8
}

$formats = @{
    "1" = "news"
    "2" = "alert"
    "3" = "daily"
    "4" = "digest"
    "5" = "explainer"
    "6" = "data"
    "7" = "article"
    "8" = "recap"
}

function Ask($prompt, $default) {
    if ($default) {
        $v = Read-Host "$prompt [$default]"
        if ([string]::IsNullOrWhiteSpace($v)) { return $default }
        return $v.Trim()
    }
    return (Read-Host $prompt).Trim()
}

function AskNumber($prompt, $default) {
    while ($true) {
        $v = Ask $prompt $default
        if ($v -match '^\d+$') { return [int]$v }
        Write-Host "  Please type a whole number (0 is fine)." -ForegroundColor Yellow
    }
}

# CSV-safe: quote only when the value contains a comma, quote or newline.
function Esc($s) {
    $s = [string]$s
    if ($s -match '[",\r\n]') { return '"' + ($s -replace '"', '""') + '"' }
    return $s
}

Write-Host ""
Write-Host "=== Add a post to scorecard.csv ===" -ForegroundColor Cyan
Write-Host "Formats: 1 news  2 alert  3 daily  4 digest  5 explainer  6 data  7 article  8 recap"
Write-Host ""

$date = Ask "Date (YYYY-MM-DD)" (Get-Date -Format "yyyy-MM-dd")
$fmtKey = Ask "Format (1-8)" "3"
if (-not $formats.ContainsKey($fmtKey)) {
    Write-Host "Unknown format '$fmtKey' - using 'daily'." -ForegroundColor Yellow
    $fmtKey = "3"
}
$format = $formats[$fmtKey]
$title = Ask "Title (short, as it appears on the post)" ""
if ([string]::IsNullOrWhiteSpace($title)) {
    Write-Host "A title is required - nothing was written." -ForegroundColor Red
    exit 1
}
$views = AskNumber "Views" "0"
$likes = AskNumber "Likes" "0"
$comments = AskNumber "Comments" "0"
$follows = AskNumber "New followers (0 if unknown)" "0"
$notes = Ask "Notes (optional)" ""

$line = (@($date, $format, $title, $views, $likes, $comments, $follows, $notes) | ForEach-Object { Esc $_ }) -join ","
Add-Content -Path $csv -Value $line -Encoding UTF8

$rows = (Get-Content $csv | Measure-Object -Line).Lines - 1
Write-Host ""
Write-Host "Added: $line" -ForegroundColor Green
Write-Host "scorecard.csv now has $rows row(s)." -ForegroundColor Green
Write-Host ""
Write-Host "After about 20 rows, compare formats by average views and average likes."
Write-Host "Keep the two that earn attention; cut or merge the rest."
