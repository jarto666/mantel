# Registers Mantel's install folder as a package, so Windows offers Mantel as the home app of
# the full screen experience (Settings > Gaming > Full screen experience). Windows allows this
# for packages Microsoft didn't sign only in Developer Mode; otherwise it does nothing.
# The installer runs it (hooks.nsh), and so does Mantel's setup once Developer Mode is on
# (fse.rs). -Remove undoes it on uninstall and gives Xbox mode back the home app from before.
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
    # Mantel's setup kept the home app it replaced; "" or a package that's gone means Windows' default.
    $gaming = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\GamingConfiguration'
    # Mantel's own key: Software\playmantel belongs to the installer.
    $ours = 'HKCU:\Software\Mantel'
    $current = (Get-ItemProperty $gaming -ErrorAction SilentlyContinue).GamingHomeApp
    if ($current -like "${name}_*") {
      $before = (Get-ItemProperty $ours -ErrorAction SilentlyContinue).PreviousHomeApp
      if ($before -and (Get-AppxPackage | Where-Object PackageFamilyName -eq $before.Split('!')[0])) {
        Set-ItemProperty $gaming GamingHomeApp $before
        Say "home app back to $before"
      } else {
        Remove-ItemProperty $gaming GamingHomeApp -ErrorAction SilentlyContinue
        Say 'home app back to the default'
      }
    }
    Remove-ItemProperty $ours PreviousHomeApp -ErrorAction SilentlyContinue
    $left = Get-Item $ours -ErrorAction SilentlyContinue
    if ($left -and -not $left.Property -and -not $left.SubKeyCount) { Remove-Item $ours -ErrorAction SilentlyContinue }
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
