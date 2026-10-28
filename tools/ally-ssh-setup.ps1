# One-time setup on the Ally: lets the dev Mac reach it over SSH (key only) to deploy
# and debug Mantel builds. Run in an elevated PowerShell:
#   irm http://<mac-ip>:8765/ally-ssh-setup.ps1 | iex
$ErrorActionPreference = 'Stop'
$key = '__KEY__'
$mac = '__MAC__'

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host 'Run PowerShell as administrator (Win+X -> Terminal (Admin)) and try again.' -ForegroundColor Red
  return
}

Write-Host '[1/5] Installing OpenSSH Server (can take a minute)...'
# Skip when sshd already exists, e.g. installed faster via `winget install Microsoft.OpenSSH.Preview`.
if (-not (Get-Service sshd -ErrorAction SilentlyContinue)) {
  $cap = Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH.Server*'
  if ($cap.State -ne 'Installed') { Add-WindowsCapability -Online -Name $cap.Name | Out-Null }
}

Write-Host '[2/5] Starting sshd and enabling it at boot...'
Set-Service -Name sshd -StartupType Automatic
Start-Service sshd

Write-Host '[3/5] Allowing port 22 through the firewall...'
# Our own rule for every network profile: installers often open 22 on Private networks
# only, and home Wi-Fi is frequently marked Public.
Remove-NetFirewallRule -Name 'Mantel-SSH-In', 'Nova-SSH-In' -ErrorAction SilentlyContinue
New-NetFirewallRule -Name 'Mantel-SSH-In' -DisplayName 'SSH for Mantel dev' -Enabled True -Profile Any `
  -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null

Write-Host '[4/5] Authorizing the Mac key (no passwords over SSH)...'
function Add-Key($path) {
  New-Item -ItemType Directory -Force -Path (Split-Path $path) | Out-Null
  if (-not (Test-Path $path) -or -not (Select-String -Path $path -SimpleMatch $key -Quiet)) {
    Add-Content -Path $path -Value $key -Encoding ascii
  }
}
# Administrators read keys from ProgramData, standard users from their profile.
$adminKeys = Join-Path $env:ProgramData 'ssh\administrators_authorized_keys'
Add-Key $adminKeys
icacls.exe $adminKeys /inheritance:r /grant 'Administrators:F' /grant 'SYSTEM:F' | Out-Null
Add-Key (Join-Path $env:USERPROFILE '.ssh\authorized_keys')

Write-Host '[5/5] Making PowerShell the SSH shell...'
New-ItemProperty -Path 'HKLM:\SOFTWARE\OpenSSH' -Name DefaultShell -PropertyType String -Force `
  -Value "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" | Out-Null

Write-Host ''
Write-Host ('sshd: ' + (Get-Service sshd).Status + ', listening on 22: ' + [bool](Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue))
Get-NetConnectionProfile | ForEach-Object { Write-Host ('network: ' + $_.Name + ' (' + $_.NetworkCategory + ')') }

$ip = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
  Select-Object -First 1).IPv4Address.IPAddress
$target = "$env:USERNAME@$ip"
try {
  Invoke-RestMethod -Method Post -Uri "http://${mac}:8765/ready" -Body $target -TimeoutSec 5 | Out-Null
  Write-Host "`nDone. The Mac now knows how to reach this Ally: $target" -ForegroundColor Green
} catch {
  Write-Host "`nDone. From the Mac: ssh $target" -ForegroundColor Green
}
