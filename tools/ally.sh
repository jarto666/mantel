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
  *)
    sed -n '2,10p' "$0"
    exit 1
    ;;
esac
