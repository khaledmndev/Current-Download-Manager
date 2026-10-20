$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$env:CURRENT_DATA_DIR=Join-Path $root '.dev-data'
$env:CARGO_HTTP_MULTIPLEXING='false'
Push-Location -LiteralPath $root
try {
    cargo build -p current-daemon --target x86_64-pc-windows-msvc --features development-pro
    if($LASTEXITCODE -ne 0){throw 'Engine build failed.'}
    npm run dev
} finally {Pop-Location}
