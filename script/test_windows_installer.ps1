param([Parameter(Mandatory = $true)][string] $Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$install = Join-Path $env:RUNNER_TEMP 'Orion Installed'
$tools = Join-Path $env:RUNNER_TEMP 'Orion Smoke Tools'
$installerProcess = Start-Process -FilePath $Installer -ArgumentList "/S /D=$install" -PassThru -Wait
if ($installerProcess.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($installerProcess.ExitCode)"
}
Write-Host "Installed Orion to $install."
foreach ($name in @('mfplat.dll', 'mfreadwrite.dll')) {
    $library = Join-Path $env:windir "System32/$name"
    Write-Host "${name} present: $(Test-Path -LiteralPath $library)"
}
$env:ORION_SMOKE_INSTALL = $install
$env:ORION_SMOKE_TOOLS = $tools
npm install --prefix $tools --no-save --package-lock=false playwright-core@1.65.0
if ($LASTEXITCODE -ne 0) { throw 'Could not install the WebView2 test driver.' }
# GitHub's Windows runner launches elevated apps. WebView2 ignores its
# environment and HKCU overrides when elevated; use a scoped HKLM test policy.
$policy = 'HKLM:/SOFTWARE/Policies/Microsoft/Edge/WebView2/AdditionalBrowserArguments'
$null = New-Item -Path $policy -Force
$existing = Get-ItemPropertyValue -LiteralPath $policy -Name 'orion.exe' -ErrorAction SilentlyContinue
try {
    Set-ItemProperty -LiteralPath $policy -Name 'orion.exe' -Type String -Value '--remote-debugging-port=9222'
    node script/smoke_windows_installer.mjs
    $smokeExit = $LASTEXITCODE
}
finally {
    if ($null -eq $existing) {
        Remove-ItemProperty -LiteralPath $policy -Name 'orion.exe' -ErrorAction SilentlyContinue
    } else {
        Set-ItemProperty -LiteralPath $policy -Name 'orion.exe' -Type String -Value $existing
    }
}
if ($smokeExit -ne 0) {
    Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddMinutes(-5) } -ErrorAction SilentlyContinue |
        Where-Object { $_.Message -match 'orion.exe|WebView2' } |
        Select-Object -First 4 -Property ProviderName, Id, Message | Format-List
    throw 'The installed Windows app did not pass its smoke test.'
}
