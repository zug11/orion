$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest
$root = Split-Path -Parent $PSScriptRoot
$resources = Join-Path $root 'src-tauri/resources'
$destination = Join-Path $resources 'windows-transcription'
$model = Join-Path $resources 'models/ggml-small.bin'
$modelHash = '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'
$zipHash = '7d8be46ecd31828e1eb7a2ecdd0d6b314feafd82163038ab6092594b0a063539'
$temp = Join-Path ([IO.Path]::GetTempPath()) ("orion-build-" + [Guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $temp

function Confirm-Hash($path, $expected) {
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $path).Hash -ne $expected) {
        throw "SHA-256 did not match for $path"
    }
}

try {
    if (!(Test-Path -LiteralPath $model) -or (Get-Item -LiteralPath $model).Length -ne 487601967) {
        $download = Join-Path $temp 'ggml-small.bin'
        Invoke-WebRequest -UseBasicParsing -Uri 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin' -OutFile $download
        Confirm-Hash $download $modelHash
        Move-Item -Force -LiteralPath $download -Destination $model
    }
    Confirm-Hash $model $modelHash

    $archive = Join-Path $temp 'whisper-bin-x64.zip'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip' -OutFile $archive
    Confirm-Hash $archive $zipHash
    Expand-Archive -LiteralPath $archive -DestinationPath $temp

    if (Test-Path -LiteralPath $destination) {
        Remove-Item -Recurse -Force -LiteralPath $destination
    }
    $null = New-Item -ItemType Directory -Path $destination
    $source = Join-Path $temp 'Release'
    Copy-Item -LiteralPath (Join-Path $source 'whisper-cli.exe'), (Join-Path $source 'whisper.dll') -Destination $destination
    Copy-Item -Path (Join-Path $source 'ggml*.dll') -Destination $destination
    Copy-Item -LiteralPath (Join-Path $resources 'licenses/whisper.cpp-LICENSE'), (Join-Path $resources 'licenses/openai-whisper-LICENSE') -Destination $destination
    Copy-Item -LiteralPath (Join-Path $root 'node_modules/tesseract.js/LICENSE.md') -Destination (Join-Path $destination 'tesseract.js-LICENSE')
    Copy-Item -LiteralPath (Join-Path $root 'node_modules/tesseract.js-core/LICENSE') -Destination (Join-Path $destination 'tesseract.js-core-LICENSE')
    Copy-Item -LiteralPath (Join-Path $root 'docs/windows-third-party.md') -Destination (Join-Path $destination 'THIRD-PARTY.md')

    $version = & (Join-Path $destination 'whisper-cli.exe') --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '1\.9\.1') {
        throw 'The staged Windows Whisper runtime could not start.'
    }
    Write-Host $version
}
finally {
    Remove-Item -Recurse -Force -LiteralPath $temp
}
