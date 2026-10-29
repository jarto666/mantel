#!/usr/bin/env bash
# Dev loop against the Ally over SSH (host alias "ally" in ~/.ssh/config).
#
#   tools/ally.sh build-dev   Windows build that loads the UI from this Mac (live reload)
#                             and exposes WebView DevTools on the Ally's localhost:9222
#   tools/ally.sh build       release build with the UI baked in
#   tools/ally.sh deploy [dev] copy the build to C:\Mantel and restart it on the Ally's screen
#   tools/ally.sh start       (re)start the deployed Mantel on the Ally's screen
#   tools/ally.sh tunnel      forward localhost:9222 to the Ally's WebView DevTools
#   tools/ally.sh logs        tail Mantel's log on the Ally
#   tools/ally.sh home        register C:\Mantel as a package, so Settings > Gaming > Full
#                             screen experience offers it as the home app "Mantel Dev" (needs
#                             the Ally in Developer Mode); `home off` unregisters it
set -euo pipefail
cd "$(dirname "$0")/.."

HOST=${ALLY_HOST:-ally}
TARGET=x86_64-pc-windows-msvc
OUT=src-tauri/target/$TARGET/release/mantel.exe
export PATH="/opt/homebrew/opt/llvm/bin:/opt/homebrew/opt/lld/bin:$PATH"

mac_ip() { ipconfig getifaddr en0 || ipconfig getifaddr en1; }

# Runs a program in the logged-in user's desktop session; plain SSH sessions have no screen.
# Scheduled-task defaults would refuse to start on battery and kill the app after 72 h.
run_on_screen() {
  ssh "$HOST" "
    \$a = New-ScheduledTaskAction -Execute '$1'
    \$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
    \$p = New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType Interactive
    Register-ScheduledTask -TaskName MantelRun -Action \$a -Settings \$s -Principal \$p -Force | Out-Null
    Start-ScheduledTask -TaskName MantelRun"
}

# Runs PowerShell in the desktop session, waits and prints the output: registering a package
# from the SSH logon fails with "access denied".
run_in_session() {
  local enc
  enc=$(printf '& { %s } *> "$env:TEMP\\mantel-task.log"' "$1" | iconv -t UTF-16LE | base64)
  ssh "$HOST" "
    \$log = \"\$env:TEMP\\mantel-task.log\"
    Remove-Item \$log -ErrorAction SilentlyContinue
    \$a = New-ScheduledTaskAction -Execute powershell.exe -Argument '-NoProfile -WindowStyle Hidden -EncodedCommand $enc'
    \$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    \$p = New-ScheduledTaskPrincipal -UserId \$env:USERNAME -LogonType Interactive
    Register-ScheduledTask -TaskName MantelSession -Action \$a -Settings \$s -Principal \$p -Force | Out-Null
    Start-ScheduledTask -TaskName MantelSession
    for (\$i = 0; \$i -lt 120 -and (-not (Test-Path \$log) -or (Get-ScheduledTask -TaskName MantelSession).State -eq 'Running'); \$i++) { Start-Sleep -Milliseconds 500 }
    Unregister-ScheduledTask -TaskName MantelSession -Confirm:\$false
    Get-Content \$log"
}

case "${1:-}" in
  build-dev)
    ip=$(mac_ip)
    config=$(python3 - "$ip" <<'EOF'
import json, sys
base = json.load(open("src-tauri/tauri.conf.json"))
win = dict(base["app"]["windows"][0], title="Mantel Dev")
win["additionalBrowserArgs"] += " --remote-debugging-port=9222"
print(json.dumps({
    "productName": "Mantel Dev",
    "build": {"devUrl": f"http://{sys.argv[1]}:1420"},
    "app": {"windows": [win]},
}))
EOF
)
    # No `custom-protocol` feature: the exe loads devUrl instead of embedded assets.
    (cd src-tauri && TAURI_CONFIG="$config" cargo xwin build --release --target $TARGET --features tauri/devtools)
    cp "$OUT" release/MantelDev.exe
    echo "Built release/MantelDev.exe (UI from http://$ip:1420). Run: TAURI_DEV_HOST=$ip npm run dev"
    ;;
  build)
    npm run build:win
    cp "$OUT" release/Mantel.exe
    ;;
  deploy)
    exe=release/Mantel.exe
    [[ "${2:-}" == dev ]] && exe=release/MantelDev.exe
    ssh "$HOST" "Stop-Process -Name mantel -Force -ErrorAction SilentlyContinue; New-Item -ItemType Directory -Force C:\\Mantel | Out-Null"
    scp -q "$exe" "$HOST:C:/Mantel/Mantel.exe"
    run_on_screen 'C:\Mantel\Mantel.exe'
    echo "Deployed $exe and restarted Mantel on the Ally."
    ;;
  start)
    run_on_screen 'C:\Mantel\Mantel.exe'
    ;;
  tunnel)
    exec ssh -N -L 9222:127.0.0.1:9222 "$HOST"
    ;;
  logs)
    ssh "$HOST" 'Get-Content -Tail 80 -Wait "$env:APPDATA\com.playmantel.launcher\mantel.log"'
    ;;
  home)
    if [[ "${2:-}" == off ]]; then
      run_in_session 'Get-AppxPackage PlayMantel.MantelDev | Remove-AppxPackage'
      echo "Unregistered; Mantel.exe stays in C:\\Mantel."
      exit
    fi
    pkg=$(mktemp -d)
    version=$(node -p 'require("./package.json").version').0
    # Its own identity, so it sits next to an installed Mantel instead of replacing it.
    sed -e "s/\$(Version)/$version/" -e 's/"PlayMantel.Mantel"/"PlayMantel.MantelDev"/' \
      -e 's/DisplayName="Mantel"/DisplayName="Mantel Dev"/g' -e 's/<DisplayName>Mantel</<DisplayName>Mantel Dev</' \
      src-tauri/msix/AppxManifest.xml > "$pkg/AppxManifest.xml"
    cp src-tauri/msix/CustomCapability.SCCD "$pkg/"
    mkdir "$pkg/Assets" "$pkg/Public"
    cp src-tauri/icons/{Square150x150Logo,Square44x44Logo,StoreLogo}.png "$pkg/Assets/"
    scp -qr "$pkg"/* "$HOST:C:/Mantel/"
    rm -rf "$pkg"
    # The deployed exe stays where it is: the package is registered in place, unsigned.
    run_in_session 'Add-AppxPackage -Register C:\Mantel\AppxManifest.xml; Get-AppxPackage PlayMantel.MantelDev | Format-List PackageFullName, InstallLocation, Status'
    ;;
  *)
    sed -n '2,13p' "$0"
    exit 1
    ;;
esac
