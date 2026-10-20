$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$env:CURRENT_DATA_DIR=Join-Path $root '.dev-data'
$env:CARGO_HTTP_MULTIPLEXING='false'
New-Item -ItemType Directory -Path $env:CURRENT_DATA_DIR -Force | Out-Null
$viteProcess=$null
Push-Location -LiteralPath $root
try {
    cargo build -p current-daemon --target x86_64-pc-windows-msvc --features development-pro
    if($LASTEXITCODE -ne 0){throw 'Engine build failed.'}
    $previewRunning=$false
    try {$response=Invoke-WebRequest -Uri 'http://127.0.0.1:1420' -TimeoutSec 2;$previewRunning=$response.Content -match 'Current Download Manager'}catch{}
    if(-not $previewRunning){
        $node=(Get-Command node).Source
        $viteProcess=Start-Process -FilePath $node -ArgumentList 'node_modules/vite/bin/vite.js','--config','apps/desktop/vite.config.ts' -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $env:CURRENT_DATA_DIR 'vite.stdout.log') -RedirectStandardError (Join-Path $env:CURRENT_DATA_DIR 'vite.stderr.log') -PassThru
    }
    Set-Location -LiteralPath (Join-Path $root 'apps\desktop')
    & (Join-Path $root 'node_modules\.bin\tauri.cmd') dev --target x86_64-pc-windows-msvc
    if($LASTEXITCODE -ne 0){throw 'Desktop development process failed.'}
} finally {
    if($viteProcess -and -not $viteProcess.HasExited){Stop-Process -Id $viteProcess.Id -ErrorAction SilentlyContinue}
    Pop-Location
}
