param([Parameter(Mandatory = $true)][string] $Installer)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$install = Join-Path $env:RUNNER_TEMP 'Orion Installed'
$tools = Join-Path $env:RUNNER_TEMP 'Orion Smoke Tools'
$installerProcess = Start-Process -FilePath $Installer -ArgumentList "/S /D=$install" -PassThru -Wait
if ($installerProcess.ExitCode -ne 0) {
    throw "NSIS installer exited with code $($installerProcess.ExitCode)"
}
$env:ORION_SMOKE_INSTALL = $install
$env:ORION_SMOKE_TOOLS = $tools
npm install --prefix $tools --no-save --package-lock=false playwright-core@1.65.0
if ($LASTEXITCODE -ne 0) { throw 'Could not install the WebView2 test driver.' }
node script/smoke_windows_installer.mjs
if ($LASTEXITCODE -ne 0) { throw 'The installed Windows app did not pass its smoke test.' }

$sample = Join-Path $env:RUNNER_TEMP 'jfk.wav'
Invoke-WebRequest -Uri 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.1/samples/jfk.wav' -OutFile $sample
if ((Get-FileHash -LiteralPath $sample -Algorithm SHA256).Hash -ne '59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e') {
    throw 'The public speech fixture did not match its SHA-256.'
}
$env:ORION_SMOKE_AUDIO = $sample
cargo test --locked --release --manifest-path src-tauri/Cargo.toml --lib installed_windows_transcription -- --ignored
if ($LASTEXITCODE -ne 0) { throw 'Transcription did not pass with the installed runtime.' }
