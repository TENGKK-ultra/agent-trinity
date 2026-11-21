# Stops only the test Core started by start-test-core.ps1. It verifies the PID
# is a node process listening on 3211 before signalling it, and never touches
# the production Core on 3210.
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $root 'data\test\core-3211.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host 'No test Core PID file; nothing to stop.'
    exit 0
}

$raw = (Get-Content -LiteralPath $pidFile -Raw).Trim()

if ($raw -notmatch '^\d+$') {
    throw "Invalid PID file: $raw"
}

$process = Get-Process -Id ([int]$raw) -ErrorAction SilentlyContinue

if (-not $process) {
    Remove-Item -LiteralPath $pidFile -Force
    Write-Host 'Test Core is already stopped.'
    exit 0
}

if ($process.ProcessName -ne 'node') {
    throw "PID $raw is not a node process; refusing to stop it."
}

$listening = Get-NetTCPConnection -LocalPort 3211 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq [int]$raw }

if (-not $listening) {
    throw "PID $raw is not listening on 3211; refusing to stop it."
}

Stop-Process -Id ([int]$raw) -Force
Remove-Item -LiteralPath $pidFile -Force
Write-Host "Test Core stopped (PID $raw)."
