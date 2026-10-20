param(
    [ValidatePattern('^[a-p]{32}$')][string]$ExtensionId='kldaaejfimcdbooimpmjhonkghbijjlg',
    [string]$NativeHost
)
$ErrorActionPreference='Stop'
if(-not $NativeHost){
    $portable=Join-Path $PSScriptRoot '..\current-native-host.exe'
    $NativeHost=if(Test-Path -LiteralPath $portable){$portable}else{Join-Path $PSScriptRoot '..\release\Current-PublicAlpha\current-native-host.exe'}
}
$hostPath=(Resolve-Path -LiteralPath $NativeHost).Path
$configDir=Join-Path $env:LOCALAPPDATA 'CurrentDownloadManager\browser'
New-Item -ItemType Directory -Path $configDir -Force | Out-Null
$manifest=Join-Path (Split-Path -Parent $hostPath) 'app.current.downloadmanager.json'
$config=Join-Path (Split-Path -Parent $hostPath) 'current-browser.json'
$origin="chrome-extension://$ExtensionId/"
$utf8=New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($config,(@{allowed_origins=@($origin)} | ConvertTo-Json),$utf8)
[System.IO.File]::WriteAllText($manifest,(@{name='app.current.downloadmanager';description='Current Download Manager browser bridge';path=$hostPath;type='stdio';allowed_origins=@($origin)} | ConvertTo-Json),$utf8)
# Write the unnamed REG_SZ explicitly in both registry views. Keep the manifest
# alongside the verified executable so a portable installation is self-contained.
foreach($view in @([Microsoft.Win32.RegistryView]::Registry32,[Microsoft.Win32.RegistryView]::Registry64)){
    $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
    try {
        foreach($browser in @('Google\Chrome','Microsoft\Edge')){
            $key=$base.CreateSubKey("Software\$browser\NativeMessagingHosts\app.current.downloadmanager")
            try {
                $key.SetValue('', $manifest, [Microsoft.Win32.RegistryValueKind]::String)
                if($key.GetValue('') -ne $manifest){throw "Native host registry verification failed for $browser ($view)."}
            } finally {$key.Dispose()}
        }
    } finally {$base.Dispose()}
}
$check=Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json
if($check.name -ne 'app.current.downloadmanager' -or -not (Test-Path -LiteralPath $check.path)){throw 'Native host manifest verification failed.'}
Write-Output "Current native host registered and verified for Chrome and Edge: $manifest"
Write-Output 'Reload Current on your browser extensions page and refresh existing YouTube tabs.'
