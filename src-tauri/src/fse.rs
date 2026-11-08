//! Windows' full screen experience (Xbox mode): no desktop or taskbar, and Windows starts its
//! home app, which can be Mantel (see src-tauri/msix). The API exists only on builds that have
//! the mode, so it is looked up at run time.

/// The package Mantel's installer registers; the suffix is the hash of its publisher.
const FAMILY: &str = "PlayMantel.Mantel_0rky18wm4wsg6";

/// Where Windows keeps the player's home app, as an app user model id.
#[cfg(windows)]
const GAMING: &str = r"Software\Microsoft\Windows\CurrentVersion\GamingConfiguration";
/// Mantel's own key: the home app Mantel replaced, which the uninstaller puts back (home-app.ps1).
#[cfg(windows)]
const OURS: &str = r"Software\PlayMantel";
#[cfg(windows)]
const UNLOCK: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\AppModelUnlock";

/// Mantel started elevated with this argument only turns on Developer Mode (see main.rs).
pub const DEVELOPER_MODE_ARG: &str = "--developer-mode";

/// The app user model id Windows starts as the home app: the package's family and app id.
#[cfg_attr(not(windows), allow(dead_code))]
fn aumid() -> String {
    format!("{FAMILY}!App")
}

#[cfg_attr(not(windows), allow(dead_code))]
fn is_ours(aumid: &str) -> bool {
    aumid.starts_with(&format!("{FAMILY}!"))
}

/// What to keep for the uninstaller when Mantel takes over from the `current` home app: nothing
/// when that's Mantel already, so a second setup doesn't forget the one before; "" for Windows'
/// default.
#[cfg_attr(not(windows), allow(dead_code))]
fn previous_to_keep(current: Option<&str>) -> Option<String> {
    match current {
        Some(c) if is_ours(c) => None,
        other => Some(other.unwrap_or_default().to_string()),
    }
}

#[cfg(windows)]
fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(Some(0)).collect()
}

#[cfg(windows)]
fn proc(name: &[u8]) -> windows_sys::Win32::Foundation::FARPROC {
    use windows_sys::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryExW, LOAD_LIBRARY_SEARCH_SYSTEM32};
    let dll = wide("api-ms-win-gaming-experience-l1-1-0.dll");
    let module = unsafe { LoadLibraryExW(dll.as_ptr(), std::ptr::null_mut(), LOAD_LIBRARY_SEARCH_SYSTEM32) };
    if module.is_null() {
        return None;
    }
    unsafe { GetProcAddress(module, name.as_ptr()) }
}

#[cfg(windows)]
fn flag(name: &[u8]) -> bool {
    type Get = unsafe extern "system" fn() -> i32;
    proc(name).is_some_and(|f| unsafe { std::mem::transmute::<_, Get>(f)() != 0 })
}

#[cfg(windows)]
pub fn supported() -> bool {
    flag(b"IsGamingFullScreenExperienceSupported\0")
}

#[cfg(windows)]
pub fn active() -> bool {
    flag(b"IsGamingFullScreenExperienceActive\0")
}

/// Whether Windows lists Mantel among home apps: the installer registered its package.
#[cfg(windows)]
pub fn offered() -> bool {
    use windows_sys::Win32::Storage::Packaging::Appx::GetPackagesByPackageFamily;
    let family = wide(FAMILY);
    let (mut count, mut len) = (0, 0);
    unsafe { GetPackagesByPackageFamily(family.as_ptr(), &mut count, std::ptr::null_mut(), &mut len, std::ptr::null_mut()) };
    count > 0
}

/// Whether Mantel is the home app, picked in Windows' Settings or by Mantel's setup.
#[cfg(windows)]
pub fn home() -> bool {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    reg::text(HKEY_CURRENT_USER, GAMING, "GamingHomeApp").is_some_and(|id| is_ours(&id))
}

/// Developer Mode: Windows registers a package Microsoft didn't sign, as Mantel's, only with it on.
#[cfg(windows)]
pub fn developer_mode() -> bool {
    use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;
    reg::number(HKEY_LOCAL_MACHINE, UNLOCK, "AllowDevelopmentWithoutDevLicense") == Some(1)
}

#[cfg(windows)]
pub fn can_switch() -> bool {
    flag(b"CanSetGamingFullScreenExperience\0")
}

/// Turns the mode on or off, as Game Bar and the mode's own "Switch to desktop" do.
#[cfg(windows)]
pub fn switch(on: bool) -> bool {
    type Set = unsafe extern "system" fn(i32) -> i32;
    can_switch() && proc(b"SetGamingFullScreenExperience\0").is_some_and(|f| unsafe { std::mem::transmute::<_, Set>(f)(on as i32) >= 0 })
}

/// Whether Windows started us through the package, as it does a home app.
#[cfg(windows)]
pub fn packaged() -> bool {
    use windows_sys::Win32::Foundation::APPMODEL_ERROR_NO_PACKAGE;
    use windows_sys::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
    let mut len = 0;
    unsafe { GetCurrentPackageFullName(&mut len, std::ptr::null_mut()) != APPMODEL_ERROR_NO_PACKAGE }
}

#[cfg(not(windows))]
pub fn supported() -> bool {
    false
}

#[cfg(not(windows))]
pub fn active() -> bool {
    false
}

#[cfg(not(windows))]
pub fn offered() -> bool {
    false
}

#[cfg(not(windows))]
pub fn home() -> bool {
    false
}

#[cfg(not(windows))]
pub fn developer_mode() -> bool {
    false
}

#[cfg(not(windows))]
pub fn can_switch() -> bool {
    false
}

#[cfg(not(windows))]
pub fn switch(_on: bool) -> bool {
    false
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Mode {
    pub supported: bool,
    pub active: bool,
    pub can_switch: bool,
    pub offered: bool,
    pub home: bool,
    pub developer_mode: bool,
}

pub fn mode() -> Mode {
    Mode { supported: supported(), active: active(), can_switch: can_switch(), offered: offered(), home: home(), developer_mode: developer_mode() }
}

/// Settings > Gaming > Full screen experience, where the home app is picked.
pub const SETTINGS_PAGE: &str = "ms-settings:gaming-fullscreen";

/// Settings > System > For developers, where Developer Mode is switched by hand.
pub const DEVELOPER_PAGE: &str = "ms-settings:developers";

#[cfg(not(windows))]
pub fn packaged() -> bool {
    false
}

/// Makes Mantel the home app, asking only for what's missing: Developer Mode (one Windows prompt
/// for permission, shown over `window`), the package registration, then the choice itself.
/// `dir` holds the installed copy of home-app.ps1 and `version` is Mantel's.
#[cfg(windows)]
pub fn make_home(window: isize, dir: &std::path::Path, version: &str) -> Result<Mode, String> {
    use windows_sys::Win32::System::Registry::HKEY_CURRENT_USER;
    if !supported() {
        return Err("This PC has no Xbox mode".into());
    }
    if !developer_mode() {
        elevate(window)?;
        if !developer_mode() {
            return Err("Developer Mode is still off. Turn it on in Windows Settings, then try again".into());
        }
    }
    if !offered() {
        register(dir, version)?;
        if !offered() {
            return Err("Windows didn't add Mantel to its home apps. Reinstalling Mantel may help".into());
        }
    }
    if let Some(before) = previous_to_keep(reg::text(HKEY_CURRENT_USER, GAMING, "GamingHomeApp").as_deref()) {
        reg::set_text(HKEY_CURRENT_USER, OURS, "PreviousHomeApp", &before)?;
    }
    reg::set_text(HKEY_CURRENT_USER, GAMING, "GamingHomeApp", &aumid())?;
    crate::log::info("made Mantel the home app of the full screen experience");
    Ok(mode())
}

#[cfg(not(windows))]
pub fn make_home(_window: isize, _dir: &std::path::Path, _version: &str) -> Result<Mode, String> {
    Err("This PC has no Xbox mode".into())
}

/// Starts this exe again with administrator rights, which Windows asks the player for, to turn on
/// Developer Mode; waits for it to finish.
#[cfg(windows)]
fn elevate(window: isize) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_CANCELLED};
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject};
    use windows_sys::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW};
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE;

    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let (verb, file, args) = (wide("runas"), wide(&exe.to_string_lossy()), wide(DEVELOPER_MODE_ARG));
    // ShellExecute wants COM, on a thread of its own as in launcher::open_uri.
    let outcome = std::thread::spawn(move || unsafe {
        CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32);
        let mut info: SHELLEXECUTEINFOW = std::mem::zeroed();
        info.cbSize = std::mem::size_of::<SHELLEXECUTEINFOW>() as u32;
        info.fMask = SEE_MASK_NOCLOSEPROCESS;
        info.hwnd = window as _;
        info.lpVerb = verb.as_ptr();
        info.lpFile = file.as_ptr();
        info.lpParameters = args.as_ptr();
        info.nShow = SW_HIDE;
        let outcome = if ShellExecuteExW(&mut info) == 0 {
            Err(GetLastError())
        } else {
            WaitForSingleObject(info.hProcess, 60_000);
            let mut code = 1;
            GetExitCodeProcess(info.hProcess, &mut code);
            CloseHandle(info.hProcess);
            Ok(code)
        };
        CoUninitialize();
        outcome
    })
    .join()
    .map_err(|_| "ShellExecute panicked".to_string())?;
    match outcome {
        Ok(0) => Ok(()),
        Ok(code) => {
            crate::log::warn(&format!("turning on Developer Mode failed with code {code}"));
            Err("Windows didn't turn on Developer Mode. Turn it on in Windows Settings, then try again".into())
        }
        Err(ERROR_CANCELLED) => Err("Windows didn't get permission, so nothing changed".into()),
        Err(e) => Err(format!("Windows couldn't ask for permission (error {e})")),
    }
}

/// The elevated run: sets the value Windows' own Developer Mode switch sets. 0 on success.
#[cfg(windows)]
pub fn turn_on_developer_mode() -> i32 {
    use windows_sys::Win32::System::Registry::HKEY_LOCAL_MACHINE;
    match reg::set_number(HKEY_LOCAL_MACHINE, UNLOCK, "AllowDevelopmentWithoutDevLicense", 1) {
        Ok(()) => 0,
        Err(_) => 1,
    }
}

#[cfg(not(windows))]
pub fn turn_on_developer_mode() -> i32 {
    1
}

/// Registers the install folder as Mantel's package, as the installer does (home-app.ps1).
#[cfg(windows)]
fn register(dir: &std::path::Path, version: &str) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let script = dir.join("home-app.ps1");
    if !script.exists() {
        return Err("Mantel's install folder is missing a file. Reinstall Mantel, then try again".into());
    }
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .args(["-Version", version])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
        .map_err(|e| e.to_string())?;
    crate::log::info(&format!("home-app.ps1 -Version {version}: {status}"));
    Ok(())
}

/// The few registry reads and writes above. 64-bit views, though Mantel is 64-bit anyway.
#[cfg(windows)]
mod reg {
    use super::wide;
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegGetValueW, RegSetValueExW, HKEY, KEY_SET_VALUE, KEY_WOW64_64KEY, REG_DWORD, REG_OPTION_NON_VOLATILE, REG_SZ,
        RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
    };

    pub fn text(root: HKEY, key: &str, value: &str) -> Option<String> {
        let (key, value) = (wide(key), wide(value));
        let mut buf = [0u16; 512];
        let mut bytes = std::mem::size_of_val(&buf) as u32;
        let found = unsafe {
            RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut bytes)
        } == 0;
        // The length counts the closing nul.
        found.then(|| String::from_utf16_lossy(&buf[..(bytes as usize / 2).saturating_sub(1)]))
    }

    pub fn number(root: HKEY, key: &str, value: &str) -> Option<u32> {
        let (key, value) = (wide(key), wide(value));
        let mut n = 0u32;
        let mut bytes = 4u32;
        let found = unsafe {
            RegGetValueW(root, key.as_ptr(), value.as_ptr(), RRF_RT_REG_DWORD | RRF_SUBKEY_WOW6464KEY, std::ptr::null_mut(), (&mut n as *mut u32).cast(), &mut bytes)
        } == 0;
        found.then_some(n)
    }

    fn set(root: HKEY, key: &str, value: &str, kind: u32, data: &[u8]) -> Result<(), String> {
        let (key_w, value_w) = (wide(key), wide(value));
        let mut handle: HKEY = std::ptr::null_mut();
        let opened = unsafe {
            RegCreateKeyExW(root, key_w.as_ptr(), 0, std::ptr::null(), REG_OPTION_NON_VOLATILE, KEY_SET_VALUE | KEY_WOW64_64KEY, std::ptr::null(), &mut handle, std::ptr::null_mut())
        };
        if opened != 0 {
            return Err(format!("Couldn't open {key} (error {opened})"));
        }
        let written = unsafe { RegSetValueExW(handle, value_w.as_ptr(), 0, kind, data.as_ptr(), data.len() as u32) };
        unsafe { RegCloseKey(handle) };
        if written == 0 {
            Ok(())
        } else {
            Err(format!("Couldn't write {value} (error {written})"))
        }
    }

    pub fn set_text(root: HKEY, key: &str, value: &str, text: &str) -> Result<(), String> {
        let data: Vec<u8> = wide(text).into_iter().flat_map(u16::to_le_bytes).collect();
        set(root, key, value, REG_SZ, &data)
    }

    pub fn set_number(root: HKEY, key: &str, value: &str, n: u32) -> Result<(), String> {
        set(root, key, value, REG_DWORD, &n.to_le_bytes())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_its_own_home_app_id() {
        assert!(is_ours(&aumid()));
        assert!(is_ours("PlayMantel.Mantel_0rky18wm4wsg6!App"));
        assert!(!is_ours("Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App"));
        // Another publisher's build of Mantel is a different package.
        assert!(!is_ours("PlayMantel.Mantel_abcdefghijklm!App"));
    }

    #[test]
    fn keeps_the_home_app_it_replaces() {
        assert_eq!(previous_to_keep(Some("Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App")).as_deref(), Some("Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App"));
        // No choice yet means Windows' default, which the uninstaller restores by removing ours.
        assert_eq!(previous_to_keep(None).as_deref(), Some(""));
        // Setting up again must not overwrite the app from before Mantel with Mantel itself.
        assert_eq!(previous_to_keep(Some(&aumid())), None);
    }
}
