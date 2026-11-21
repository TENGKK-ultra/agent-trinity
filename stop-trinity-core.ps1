$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$pidFile = Join-Path $env:TEMP 'trinity-core.pid'

if (-not (Test-Path -LiteralPath $pidFile)) {
    Write-Host "没有找到由启动器记录的 Core 进程，未做任何操作。" -ForegroundColor Yellow
    exit 0
}

$corePid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
if ($corePid -notmatch '^\d+$') {
    Write-Host "PID 记录无效：$corePid" -ForegroundColor Yellow
    exit 1
}

$proc = Get-Process -Id ([int]$corePid) -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "记录的 Core（PID $corePid）已经不在运行，清理记录。" -ForegroundColor DarkGray
    Remove-Item -LiteralPath $pidFile -Force
    exit 0
}

# 只结束确认监听 3210 且确实是 node 的进程，避免误杀其他 Node 程序。
$listening = Get-NetTCPConnection -LocalPort 3210 -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.OwningProcess -eq [int]$corePid }

if ($proc.ProcessName -ne 'node' -or -not $listening) {
    Write-Host "PID $corePid 的进程不是正在监听 3210 的 Trinity Core，已放弃结束。" -ForegroundColor Yellow
    exit 1
}

Stop-Process -Id ([int]$corePid) -Force
Remove-Item -LiteralPath $pidFile -Force
Write-Host "已停止由启动器启动的 Trinity Core（PID $corePid）。" -ForegroundColor Green
