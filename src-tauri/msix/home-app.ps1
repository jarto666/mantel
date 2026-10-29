# Registers Mantel's install folder as a package, so Windows offers Mantel as the home app of
# the full screen experience (Settings > Gaming > Full screen experience). Windows allows this
# for packages Microsoft didn't sign only in Developer Mode; otherwise it does nothing.
# The installer runs it (hooks.nsh); -Remove undoes it on uninstall.
param([string]$Version, [switch]$Remove)

$name = 'PlayMantel.Mantel'
$public = Join-Path $PSScriptRoot 'Public'
$log = Join-Path $env:APPDATA 'com.playmantel.launcher\home-app.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null
function Say($text) { "$(Get-Date -Format s) $text" | Add-Content $log }

try {
  # Also drops a registration of another copy, so the home app is the one just installed.
  Get-AppxPackage $name | Where-Object { $Remove -or $_.InstallLocation -ne $PSScriptRoot } | Remove-AppxPackage
  if ($Remove) {
    # Registering adds a hidden bookkeeping folder that would keep the uninstaller from removing ours.
    Remove-Item $public, (Join-Path $PSScriptRoot 'microsoft.system.package.metadata') -Recurse -Force -ErrorAction SilentlyContinue
    Say 'unregistered'
    return
  }
  # The 64-bit view: under the 32-bit installer HKLM:\SOFTWARE is the WOW6432Node copy.
  $hklm = [Microsoft.Win32.RegistryKey]::OpenBaseKey('LocalMachine', 'Registry64')
  $unlock = $hklm.OpenSubKey('SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock')
  if (-not $unlock -or $unlock.GetValue('AllowDevelopmentWithoutDevLicense') -ne 1) {
    Say 'Developer Mode is off, so Mantel is not offered as the home app'
    return
  }
  $path = Join-Path $PSScriptRoot 'AppxManifest.xml'
  [xml]$manifest = Get-Content $path
  $manifest.Package.Identity.Version = "$Version.0"
  $manifest.Save($path)
  New-Item -ItemType Directory -Force $public | Out-Null
  Add-AppxPackage -Register $path -ErrorAction Stop
  Say "registered $Version from $PSScriptRoot"
} catch {
  Say "failed: $_"
}
