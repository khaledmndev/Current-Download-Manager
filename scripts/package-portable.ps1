param(
    [string]$BinaryDirectory='target\x86_64-pc-windows-msvc\release',
    [ValidatePattern('^[a-zA-Z0-9._-]+$')][string]$OutputName='Current-PublicAlpha',
    [ValidatePattern('^[a-zA-Z0-9._-]+\.zip$')][string]$ArchiveName='Current-public-alpha-windows-x64.zip'
)
$ErrorActionPreference='Stop'
$root=(Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$binaries=if([IO.Path]::IsPathRooted($BinaryDirectory)){$BinaryDirectory}else{Join-Path $root $BinaryDirectory}
$destination=Join-Path (Join-Path $root 'release') $OutputName
if(Test-Path -LiteralPath $destination){throw 'Choose a fresh output directory; existing application/configuration files will not be copied into a public package.'}
$notices=Join-Path $root 'THIRD_PARTY_LICENSES'
$inventory=Get-Content -LiteralPath (Join-Path $notices 'inventory.json') -Raw | ConvertFrom-Json
if(@($inventory.missing_notices).Count -gt 0){throw 'Resolve missing third-party notices before packaging.'}
foreach($name in @('current-desktop.exe','current-daemon.exe','current-cli.exe','current-native-host.exe')){
    if(-not (Test-Path -LiteralPath (Join-Path $binaries $name))){throw "Missing binary: $name"}
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
foreach($name in @('current-desktop.exe','current-daemon.exe','current-cli.exe','current-native-host.exe')){
    $outputName=if($name -eq 'current-desktop.exe'){'Current.exe'}else{$name}
    Copy-Item -LiteralPath (Join-Path $binaries $name) -Destination (Join-Path $destination $outputName)
}
foreach($name in @('README.md','LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md')){
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination $destination
}
foreach($name in @('docs','branding','THIRD_PARTY_LICENSES')){
    Copy-Item -LiteralPath (Join-Path $root $name) -Destination $destination -Recurse
}
New-Item -ItemType Directory -Path (Join-Path $destination 'extensions'),(Join-Path $destination 'scripts') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root 'extensions\chromium') -Destination (Join-Path $destination 'extensions') -Recurse
foreach($name in @('register-browser.ps1','install-media.py','media-runtime.json')){
    Copy-Item -LiteralPath (Join-Path $root "scripts\$name") -Destination (Join-Path $destination 'scripts')
}
# Explicit public boundary: no media executables, QA captures, research, or host config.
$forbidden=@('yt-dlp.exe','deno.exe','ffmpeg.exe','ffprobe.exe','current-browser.json','app.current.downloadmanager.json')
$files=Get-ChildItem -LiteralPath $destination -Recurse -File
foreach($file in $files){if($file.Name -in $forbidden){throw "Unexpected private/runtime file: $($file.Name)"}}
$files | Get-FileHash -Algorithm SHA256 | ForEach-Object {
    $relative=$_.Path.Substring($destination.Length).TrimStart('\','/').Replace('\','/')
    "$($_.Hash.ToLowerInvariant())  $relative"
} | Set-Content -LiteralPath (Join-Path $destination 'SHA256SUMS.txt') -Encoding utf8
& python (Join-Path $root 'scripts\check-package.py') $destination
if($LASTEXITCODE -ne 0){throw 'Public package validation failed; no archive was produced.'}
Compress-Archive -LiteralPath $destination -DestinationPath (Join-Path (Join-Path $root 'release') $ArchiveName) -Force
Write-Output "Public alpha: $destination\Current.exe"
Write-Output 'External media tools are intentionally omitted. Use scripts/install-media.py locally.'
