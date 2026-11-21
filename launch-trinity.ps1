$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$coreDir = Join-Path $root 'trinity-core'
$exe = Join-Path $root 'trinity-desktop\src-tauri\target\release\trinity-desktop.exe'
$pidFile = Join-Path $env:TEMP 'trinity-core.pid'

function Show-Problem {
    param([string]$Message)
    Write-Host $Message -ForegroundColor Red
    [void][System.Windows.Forms.MessageBox]::Show(
        $Message,
        'Trinity 启动失败',
        [System.Windows.Forms.MessageBoxButtons]::OK,
        [System.Windows.Forms.MessageBoxIcon]::Error
    )
}

function Test-CorePort {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', 3210)
        $client.Close()
        return $true
    } catch {
        return $false
    }
}

if (-not (Test-Path -LiteralPath $exe)) {
    Show-Problem "找不到桌面端可执行文件：`n$exe`n`n请先在 trinity-desktop 下执行：`nnpm run tauri build -- --no-bundle"
    exit 1
}

if (Test-CorePort) {
    Write-Host "检测到 Trinity Core 已在运行，直接复用（不会重复启动）。" -ForegroundColor DarkGray
} else {
    $node = Get-Command node -ErrorAction SilentlyContinue
    if (-not $node) {
        Show-Problem "找不到 node 命令。`n`n请确认已安装 Node.js 并加入 PATH，然后重试。"
        exit 1
    }

    Write-Host "正在启动 Trinity Core…" -ForegroundColor Cyan

    $core = Start-Process -FilePath $node.Source `
        -ArgumentList 'src/main.ts' `
        -WorkingDirectory $coreDir `
        -WindowStyle Hidden `
        -PassThru

    Set-Content -LiteralPath $pidFile -Value $core.Id -Encoding ascii

    $ready = $false
    for ($i = 0; $i -lt 40; $i++) {
        Start-Sleep -Milliseconds 500
        if (Test-CorePort) { $ready = $true; break }
        if ($core.HasExited) { break }
    }

    if ($ready) {
        Write-Host "Core 已就绪（PID $($core.Id)）。" -ForegroundColor Green
    } else {
        Show-Problem "Trinity Core 未能在 20 秒内启动。`n`n可以手动在 $coreDir 下运行：`nnode src/main.ts`n`n查看具体报错。"
    }
}

Write-Host "正在打开 Trinity…" -ForegroundColor Cyan
Start-Process -FilePath $exe

Start-Sleep -Milliseconds 800
exit 0
