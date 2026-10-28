use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Power {
    pub has_battery: bool,
    pub percent: Option<u8>,
    pub charging: bool,
}

#[cfg(windows)]
pub fn power() -> Power {
    use windows_sys::Win32::System::Power::{GetSystemPowerStatus, SYSTEM_POWER_STATUS};
    let mut s: SYSTEM_POWER_STATUS = unsafe { std::mem::zeroed() };
    if unsafe { GetSystemPowerStatus(&mut s) } == 0 {
        return Power::default();
    }
    Power {
        // 128 = no system battery, 255 = unknown.
        has_battery: s.BatteryFlag != 128 && s.BatteryFlag != 255,
        percent: (s.BatteryLifePercent <= 100).then_some(s.BatteryLifePercent),
        charging: s.ACLineStatus == 1,
    }
}

#[cfg(not(windows))]
pub fn power() -> Power {
    Power::default()
}

pub fn action(app: &AppHandle, action: &str) -> Result<(), String> {
    let shutdown = |args: &[&str]| {
        std::process::Command::new("shutdown").args(args).spawn().map(|_| ()).map_err(|e| e.to_string())
    };
    match action {
        "shutdown" => shutdown(&["/s", "/t", "0"]),
        "restart" => shutdown(&["/r", "/t", "0"]),
        "desktop" => {
            if let Some(w) = app.get_webview_window("main") {
                w.minimize().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        "quit" => {
            app.exit(0);
            Ok(())
        }
        other => Err(format!("unknown action {other}")),
    }
}
