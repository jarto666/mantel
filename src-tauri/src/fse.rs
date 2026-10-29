//! Windows' full screen experience (Xbox mode): no desktop or taskbar, and Windows starts its
//! home app, which can be Mantel (see src-tauri/msix). The API exists only on builds that have
//! the mode, so it is looked up at run time.

/// The package Mantel's installer registers; the suffix is the hash of its publisher.
#[cfg(windows)]
const FAMILY: &str = "PlayMantel.Mantel_0rky18wm4wsg6";

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

/// Whether the user picked Mantel as the home app; Windows leaves that choice to them, in Settings.
#[cfg(windows)]
pub fn home() -> bool {
    use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_SZ};
    let (key, value) = (wide(r"Software\Microsoft\Windows\CurrentVersion\GamingConfiguration"), wide("GamingHomeApp"));
    let mut buf = [0u16; 256];
    let mut bytes = std::mem::size_of_val(&buf) as u32;
    let found = unsafe {
        RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut bytes)
    } == 0;
    // An app user model id: "<family>!App".
    found && String::from_utf16_lossy(&buf[..bytes as usize / 2]).starts_with(&format!("{FAMILY}!"))
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
}

pub fn mode() -> Mode {
    Mode { supported: supported(), active: active(), can_switch: can_switch(), offered: offered(), home: home() }
}

/// Settings > Gaming > Full screen experience, where the home app is picked.
pub const SETTINGS_PAGE: &str = "ms-settings:gaming-fullscreen";

#[cfg(not(windows))]
pub fn packaged() -> bool {
    false
}
