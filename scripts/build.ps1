param([switch]$DevelopmentPro,[switch]$DebugBuild)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $root
try {
    npm ci --no-audit --no-fund
    if($LASTEXITCODE -ne 0){throw 'Frontend dependency installation failed.'}
    npm run build
    if($LASTEXITCODE -ne 0){throw 'Frontend build failed.'}
    $buildArgs=@('scripts/build-rust.py')
    if($DevelopmentPro){$buildArgs+='--development-pro'}
    if($DebugBuild){$buildArgs+='--debug'}
    & python @buildArgs
    if($LASTEXITCODE -ne 0){throw 'Rust build failed.'}
    if($DebugBuild){Write-Output 'Debug binaries built. Public packaging requires an optimized release build.';return}
    python scripts/generate-notices.py
    if($LASTEXITCODE -ne 0){throw 'Dependency license review failed.'}
    python scripts/check-public.py
    if($LASTEXITCODE -ne 0){throw 'Public source checks failed.'}
    & ./scripts/package-portable.ps1
    if($DevelopmentPro){Write-Output 'DEVELOPMENT PRO alpha: no paid license or billing activation.'}
} finally {Pop-Location}
