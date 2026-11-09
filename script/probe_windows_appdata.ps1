$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$root = Join-Path $env:RUNNER_TEMP 'Orion Connector MSIX Probe'
$pack = Join-Path $root 'package'
$vaultDir = Join-Path $env:APPDATA 'app.orion.knowledge'
$assets = Join-Path $pack 'Assets'
New-Item -ItemType Directory -Force -Path $assets, $vaultDir | Out-Null
Copy-Item src-tauri/tests/fixtures/mcp-vault.json (Join-Path $vaultDir 'vault.json')
New-Item -ItemType File -Path (Join-Path $vaultDir 'vault.lock') | Out-Null
Copy-Item src-tauri/mcp-server/target/release/orion-mcp.exe $root
$env:ORION_APPDATA_PROBE_ROOT = $root

@'
use std::{fs, io::Write, path::PathBuf, process::{Command, Stdio}};
fn probe(root: &std::path::Path) -> Result<String, Box<dyn std::error::Error>> {
    let vault = PathBuf::from(std::env::var_os("APPDATA").ok_or("Missing AppData")?)
        .join("app.orion.knowledge/vault.json");
    let staging = vault.with_file_name("orion-virtualization-probe.tmp");
    fs::write(&staging, "probe")?;
    let mut mcp = Command::new(root.join("orion-mcp.exe"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    mcp.stdin.take().unwrap().write_all(
        b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"orion_create_note\",\"arguments\":{\"space_id\":\"space-alpha\",\"title\":\"MSIX Orion probe note\",\"body\":\"A packaged client wrote this note.\"}}}\n",
    )?;
    let output = mcp.wait_with_output()?;
    Ok(format!("Executable: {:?}\nExisting vault: {:?}\nNew file: {:?}\nMCP status: {}\nMCP reply: {}\nMCP stderr: {}",
        fs::canonicalize(std::env::current_exe()?)?, fs::canonicalize(vault)?, fs::canonicalize(staging)?,
        output.status, String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr)))
}
fn main() {
    let root = PathBuf::from(env!("ORION_APPDATA_PROBE_ROOT"));
    let result = probe(&root).unwrap_or_else(|error| format!("Probe failed: {error}"));
    fs::write(root.join("report.txt"), result).unwrap();
}
'@ | Set-Content (Join-Path $root 'probe.rs') -Encoding utf8NoBOM
rustc --edition=2021 -o (Join-Path $pack 'probe.exe') (Join-Path $root 'probe.rs')

@'
<?xml version="1.0" encoding="utf-8"?>
<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="Orion.ConnectorProbe" Publisher="CN=OrionConnectorProbe" Version="1.0.0.0" ProcessorArchitecture="x64"/>
  <Properties><DisplayName>Orion Connector Probe</DisplayName><PublisherDisplayName>Orion</PublisherDisplayName><Logo>Assets\StoreLogo.png</Logo></Properties>
  <Dependencies><TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0"/></Dependencies>
  <Resources><Resource Language="en-us"/></Resources>
  <Applications>
    <Application Id="Probe" Executable="probe.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="Orion Connector Probe" Description="Disposable connector verification" Square150x150Logo="Assets\Square150.png" Square44x44Logo="Assets\Square44.png" BackgroundColor="transparent"/>
    </Application>
  </Applications>
  <Capabilities><rescap:Capability Name="runFullTrust"/></Capabilities>
</Package>
'@ | Set-Content (Join-Path $pack 'AppxManifest.xml') -Encoding utf8NoBOM
Add-Type -AssemblyName System.Drawing
$art = [System.Drawing.Image]::FromFile((Resolve-Path 'src-tauri/icons/icon.png').Path)
foreach ($entry in @{StoreLogo=50;Square150=150;Square44=44}.GetEnumerator()) {
  $image = [System.Drawing.Bitmap]::new($art, [int]$entry.Value, [int]$entry.Value)
  $image.Save((Join-Path $assets ($entry.Key + '.png')), [System.Drawing.Imaging.ImageFormat]::Png)
  $image.Dispose()
}
$art.Dispose()

$sdk = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Directory | Sort-Object Name -Descending |
  Where-Object { Test-Path (Join-Path $_.FullName 'x64\makeappx.exe') } | Select-Object -First 1
$msix = Join-Path $root 'OrionProbe.msix'
& (Join-Path $sdk.FullName 'x64\makeappx.exe') pack /d $pack /p $msix /o
$cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject 'CN=OrionConnectorProbe' -CertStoreLocation 'Cert:\CurrentUser\My'
$certPath = Join-Path $root 'OrionProbe.cer'
Export-Certificate -Cert $cert -FilePath $certPath | Out-Null
Import-Certificate -FilePath $certPath -CertStoreLocation 'Cert:\LocalMachine\TrustedPeople' | Out-Null
& (Join-Path $sdk.FullName 'x64\signtool.exe') sign /fd SHA256 /sha1 $cert.Thumbprint $msix
Add-AppxPackage -Path $msix
$installed = Get-AppxPackage -Name 'Orion.ConnectorProbe'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[ComImport, Guid("2e941141-7f97-4756-ba1d-9decde894a3d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IActivation {
  [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string appId, [MarshalAs(UnmanagedType.LPWStr)] string args, uint options, out uint processId);
}
[ComImport, Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")]
public class ActivationManager {}
public static class LaunchPackaged {
  public static uint Run(string id) {
    uint pid;
    int result = ((IActivation)new ActivationManager()).ActivateApplication(id, null, 0, out pid);
    Marshal.ThrowExceptionForHR(result);
    return pid;
  }
}
'@
$processId = [LaunchPackaged]::Run($installed.PackageFamilyName + '!Probe')
Write-Host "Launched packaged process $processId"
$report = Join-Path $root 'report.txt'
for ($i = 0; $i -lt 30 -and !(Test-Path -LiteralPath $report); $i++) { Start-Sleep -Seconds 1 }
Get-Content -LiteralPath $report
if (!(Select-String -Quiet -SimpleMatch 'MSIX Orion probe note' -LiteralPath (Join-Path $vaultDir 'vault.json'))) {
  throw 'The connector write did not reach the ordinary vault.'
}
Write-Host 'The packaged MCP launch updated the ordinary vault.'
