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
$policy = [Microsoft.Win32.Registry]::LocalMachine.CreateSubKey('SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments')
$existing = $policy.GetValue('orion.exe')
try {
    $policy.SetValue('orion.exe', '--remote-debugging-port=9222', [Microsoft.Win32.RegistryValueKind]::String)
    node script/smoke_windows_installer.mjs
    $smokeExit = $LASTEXITCODE
}
finally {
    if ($null -eq $existing) {
        $policy.DeleteValue('orion.exe', $false)
    } else {
        $policy.SetValue('orion.exe', $existing, [Microsoft.Win32.RegistryValueKind]::String)
    }
    $policy.Dispose()
}
if ($smokeExit -ne 0) {
    Get-WinEvent -FilterHashtable @{ LogName = 'Application'; StartTime = (Get-Date).AddMinutes(-5) } -ErrorAction SilentlyContinue |
        Where-Object { $_.Message -match 'orion.exe|WebView2' } |
        Select-Object -First 4 -Property ProviderName, Id, Message | Format-List
    throw 'The installed Windows app did not pass its smoke test.'
}

$sample = Join-Path $env:RUNNER_TEMP 'jfk.wav'
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.1/samples/jfk.wav' -OutFile $sample
if ((Get-FileHash -LiteralPath $sample -Algorithm SHA256).Hash -ne '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e') {
    throw 'The public speech fixture did not match its SHA-256.'
}
$env:ORION_SMOKE_AUDIO = $sample
cargo test --locked --release --manifest-path src-tauri/Cargo.toml --lib installed_windows_transcription -- --ignored
if ($LASTEXITCODE -ne 0) { throw 'Transcription did not pass with the installed runtime.' }
