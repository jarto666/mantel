//! One-time move from the app's old name, Nova: settings, playtime, the art cache and the
//! WebView's cookie jar (the Steam sign-in) follow, and so does "Start with Windows".

#[derive(Default)]
pub struct Moved {
    pub data: bool,
    pub autostart: bool,
}

/// Must run before any window exists: the WebView locks its folder once it starts.
#[cfg(windows)]
pub fn from_nova(identifier: &str) -> Moved {
    const OLD_ID: &str = "dev.nova.launcher";
    let mut moved = Moved::default();
    for var in ["APPDATA", "LOCALAPPDATA"] {
        let Some(base) = std::env::var_os(var).map(std::path::PathBuf::from) else { continue };
        let (old, new) = (base.join(OLD_ID), base.join(identifier));
        if old.is_dir() && !new.exists() && std::fs::rename(&old, &new).is_ok() {
            moved.data = true;
        }
    }
    // Only once Nova's own data turned up, so another app's "Nova" entry is left alone.
    if moved.data {
        moved.autostart = ["Nova", "Nova Dev"].iter().fold(false, |any, name| delete_run_entry(name) || any);
    }
    moved
}

#[cfg(windows)]
fn delete_run_entry(name: &str) -> bool {
    use windows_sys::Win32::System::Registry::{RegDeleteKeyValueW, HKEY_CURRENT_USER};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (key, value) = (wide(r"Software\Microsoft\Windows\CurrentVersion\Run"), wide(name));
    unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr()) == 0 }
}

#[cfg(not(windows))]
pub fn from_nova(_identifier: &str) -> Moved {
    Moved::default()
}
