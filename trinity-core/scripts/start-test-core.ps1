# Starts an isolated P3 test Core next to the running production instance.
# It listens on 3211 only, uses data\test\trinity-p3.db, and never touches the
# production database or port. The Core itself refuses a test instance that
# points at either of them.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$testDir = Join-Path $root 'data\test'
$port = 3211
$dbPath = Join-Path $testDir 'trinity-p3.db'
$outLog = Join-Path $testDir 'core-3211.out.log'
$errLog = Join-Path $testDir 'core-3211.err.log'
$pidFile = Join-Path $testDir 'core-3211.pid'

if ($port -eq 3210) {
    throw 'Refusing to start a test Core on the production port.'
}

New-Item -ItemType Directory -Force -Path $testDir | Out-Null

if (Test-Path -LiteralPath $pidFile) {
    $existing = (Get-Content -LiteralPath $pidFile -Raw).Trim()

    if ($existing -match '^\d+$' -and (Get-Process -Id ([int]$existing) -ErrorAction SilentlyContinue)) {
        Write-Host "Test Core is already running (PID $existing)." -ForegroundColor Yellow
        exit 0
    }

    Remove-Item -LiteralPath $pidFile -Force
}

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue

if ($listening) {
    throw "Port $port is already in use (PID $($listening[0].OwningProcess))."
}

$node = Get-Command node -ErrorAction SilentlyContinue

if (-not $node) {
    throw 'node was not found on PATH.'
}

$env:TRINITY_PORT = "$port"
$env:TRINITY_DB_PATH = $dbPath
$env:TRINITY_ENV = 'test'
$env:TRINITY_HOST = '127.0.0.1'

$process = Start-Process -FilePath $node.Source -ArgumentList 'src/main.ts' `
    -WorkingDirectory $root `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru

Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii

$ready = $false

for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250

    if ($process.HasExited) {
        break
    }

    if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) {
        $ready = $true
        break
    }
}

if (-not $ready) {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }

    Write-Host 'Test Core failed to start. Last error lines:' -ForegroundColor Red
    Get-Content -LiteralPath $errLog -ErrorAction SilentlyContinue | Select-Object -Last 20
    throw 'Test Core did not start.'
}

Write-Host 'Test Core started.' -ForegroundColor Green
Write-Host "  PID:  $($process.Id)"
Write-Host "  URL:  http://127.0.0.1:$port"
Write-Host "  DB:   $dbPath"
Write-Host "  Logs: $outLog"
