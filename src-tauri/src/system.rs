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

/// What the control center can show and change. Anything the device lacks stays empty.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quick {
    /// 0–100; empty without an output device.
    pub volume: Option<u8>,
    pub muted: bool,
    /// 0–100; empty when the screen can't be dimmed from here, like an external monitor.
    pub brightness: Option<u8>,
    /// Empty without a Wi-Fi adapter.
    pub wifi: Option<Wifi>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Wifi {
    pub connected: bool,
    pub name: Option<String>,
    /// Signal quality, 0–100.
    pub signal: Option<u8>,
}

#[cfg(windows)]
pub fn quick() -> Quick {
    let (volume, muted) = controls::volume().map_or((None, false), |(v, m)| (Some(v), m));
    Quick { volume, muted, brightness: controls::brightness(), wifi: controls::wifi() }
}

#[cfg(not(windows))]
pub fn quick() -> Quick {
    Quick::default()
}

#[cfg(windows)]
pub use controls::{set_brightness, set_muted, set_volume};

#[cfg(not(windows))]
pub fn set_volume(_: u8) -> Result<(), String> {
    Err("Volume is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn set_muted(_: bool) -> Result<(), String> {
    Err("Volume is only available on Windows".into())
}

#[cfg(not(windows))]
pub fn set_brightness(_: u8) -> Result<(), String> {
    Err("Brightness is only available on Windows".into())
}

/// Volume through Core Audio, the built-in panel's brightness through WMI, Wi-Fi through
/// the WLAN API. Commands call these on worker threads, each joining COM for the call.
#[cfg(windows)]
mod controls {
    use windows::core::{w, BSTR, PCWSTR};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoSetProxyBlanket, CoUninitialize, CLSCTX_ALL, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED, EOAC_NONE,
        RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
    };
    use windows::Win32::System::Rpc::{RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE};
    use windows::Win32::System::Variant::{VariantClear, VARENUM, VARIANT, VT_BSTR, VT_I4, VT_UI1};
    use windows::Win32::System::Wmi::{
        IWbemClassObject, IWbemContext, IWbemLocator, IWbemServices, WbemLocator, WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_GENERIC_FLAG_TYPE,
        WBEM_INFINITE,
    };

    use super::Wifi;

    struct Com(bool);

    impl Com {
        fn join() -> Self {
            Com(unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.is_ok())
        }
    }

    impl Drop for Com {
        fn drop(&mut self) {
            if self.0 {
                unsafe { CoUninitialize() };
            }
        }
    }

    fn text(e: windows::core::Error) -> String {
        e.message()
    }

    fn speakers() -> windows::core::Result<IAudioEndpointVolume> {
        unsafe {
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            devices.GetDefaultAudioEndpoint(eRender, eConsole)?.Activate(CLSCTX_ALL, None)
        }
    }

    pub fn volume() -> Option<(u8, bool)> {
        let _com = Com::join();
        let out = speakers().ok()?;
        unsafe { Some(((out.GetMasterVolumeLevelScalar().ok()? * 100.0).round() as u8, out.GetMute().ok()?.as_bool())) }
    }

    /// Like the volume keys, turning it up also unmutes.
    pub fn set_volume(level: u8) -> Result<(), String> {
        let _com = Com::join();
        let out = speakers().map_err(text)?;
        unsafe {
            out.SetMasterVolumeLevelScalar(f32::from(level.min(100)) / 100.0, std::ptr::null()).map_err(text)?;
            if level > 0 {
                out.SetMute(false, std::ptr::null()).map_err(text)?;
            }
        }
        Ok(())
    }

    pub fn set_muted(muted: bool) -> Result<(), String> {
        let _com = Com::join();
        unsafe { speakers().and_then(|out| out.SetMute(muted, std::ptr::null())).map_err(text) }
    }

    fn wmi() -> windows::core::Result<IWbemServices> {
        unsafe {
            let locator: IWbemLocator = CoCreateInstance(&WbemLocator, None, CLSCTX_INPROC_SERVER)?;
            let none = BSTR::new();
            let services = locator.ConnectServer(&BSTR::from(r"ROOT\WMI"), &none, &none, &none, 0, &none, None::<&IWbemContext>)?;
            CoSetProxyBlanket(&services, RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE, PCWSTR::null(), RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE, None, EOAC_NONE)?;
            Ok(services)
        }
    }

    /// The first object a query returns: the built-in panel is the only active monitor
    /// these classes know, external ones don't take brightness through WMI.
    fn first(services: &IWbemServices, query: &str) -> Option<IWbemClassObject> {
        unsafe {
            let rows = services
                .ExecQuery(&BSTR::from("WQL"), &BSTR::from(query), WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY, None::<&IWbemContext>)
                .ok()?;
            let mut row = [None];
            let mut found = 0;
            rows.Next(WBEM_INFINITE, &mut row, &mut found).ok().ok()?;
            row[0].take().filter(|_| found > 0)
        }
    }

    fn variant(vt: VARENUM, set: impl FnOnce(&mut windows::Win32::System::Variant::VARIANT_0_0_0)) -> VARIANT {
        let mut v = VARIANT::default();
        unsafe {
            let inner = &mut *v.Anonymous.Anonymous;
            inner.vt = vt;
            set(&mut inner.Anonymous);
        }
        v
    }

    pub fn brightness() -> Option<u8> {
        let _com = Com::join();
        let services = wmi().ok()?;
        let row = first(&services, "SELECT CurrentBrightness FROM WmiMonitorBrightness WHERE Active = TRUE")?;
        let mut v = VARIANT::default();
        unsafe {
            row.Get(w!("CurrentBrightness"), 0, &mut v, None, None).ok()?;
            let inner = &*v.Anonymous.Anonymous;
            (inner.vt == VT_UI1).then(|| inner.Anonymous.bVal)
        }
    }

    pub fn set_brightness(level: u8) -> Result<(), String> {
        let _com = Com::join();
        let services = wmi().map_err(text)?;
        let row = first(&services, "SELECT * FROM WmiMonitorBrightnessMethods WHERE Active = TRUE").ok_or("This screen's brightness can't be set")?;
        unsafe {
            let mut path = VARIANT::default();
            row.Get(w!("__PATH"), 0, &mut path, None, None).map_err(text)?;
            let inner = &*path.Anonymous.Anonymous;
            let path_text = if inner.vt == VT_BSTR { (*inner.Anonymous.bstrVal).clone() } else { BSTR::new() };
            let _ = VariantClear(&mut path);

            let mut class = None;
            services
                .GetObject(&BSTR::from("WmiMonitorBrightnessMethods"), WBEM_GENERIC_FLAG_TYPE(0), None::<&IWbemContext>, Some(&mut class), None)
                .map_err(text)?;
            let mut input = None;
            class.ok_or("No brightness control")?.GetMethod(w!("WmiSetBrightness"), 0, &mut input, std::ptr::null_mut()).map_err(text)?;
            let params = input.ok_or("No brightness control")?.SpawnInstance(0).map_err(text)?;
            // uint32 travels as VT_I4 in WMI.
            params.Put(w!("Timeout"), 0, &variant(VT_I4, |x| x.lVal = 0), 0).map_err(text)?;
            params.Put(w!("Brightness"), 0, &variant(VT_UI1, |x| x.bVal = level.min(100)), 0).map_err(text)?;
            services
                .ExecMethod(&path_text, &BSTR::from("WmiSetBrightness"), WBEM_GENERIC_FLAG_TYPE(0), None::<&IWbemContext>, &params, None, None)
                .map_err(text)?;
        }
        Ok(())
    }

    /// The connected network's name and signal. Windows 11 hides the name from apps without
    /// location access; the rest still comes through.
    pub fn wifi() -> Option<Wifi> {
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::NetworkManagement::WiFi::{
            wlan_interface_state_connected, wlan_intf_opcode_current_connection, WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory, WlanOpenHandle,
            WlanQueryInterface, WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST,
        };
        unsafe {
            let (mut version, mut handle) = (0, null_mut());
            if WlanOpenHandle(2, null(), &mut version, &mut handle) != 0 {
                return None;
            }
            let mut list: *mut WLAN_INTERFACE_INFO_LIST = null_mut();
            let mut found = None;
            if WlanEnumInterfaces(handle, null(), &mut list) == 0 && !list.is_null() {
                let items = std::slice::from_raw_parts((*list).InterfaceInfo.as_ptr(), (*list).dwNumberOfItems as usize);
                if !items.is_empty() {
                    let mut wifi = Wifi { connected: false, name: None, signal: None };
                    if let Some(item) = items.iter().find(|i| i.isState == wlan_interface_state_connected) {
                        wifi.connected = true;
                        let (mut size, mut data) = (0, null_mut());
                        if WlanQueryInterface(handle, &item.InterfaceGuid, wlan_intf_opcode_current_connection, null(), &mut size, &mut data, null_mut()) == 0
                            && !data.is_null()
                        {
                            let link = &(*(data as *const WLAN_CONNECTION_ATTRIBUTES)).wlanAssociationAttributes;
                            let ssid = &link.dot11Ssid.ucSSID[..(link.dot11Ssid.uSSIDLength as usize).min(32)];
                            wifi.name = Some(String::from_utf8_lossy(ssid).to_string()).filter(|n| !n.is_empty());
                            wifi.signal = Some(link.wlanSignalQuality.min(100) as u8);
                            WlanFreeMemory(data);
                        }
                    }
                    found = Some(wifi);
                }
                WlanFreeMemory(list as _);
            }
            WlanCloseHandle(handle, null());
            found
        }
    }
}

pub fn action(app: &AppHandle, action: &str) -> Result<(), String> {
    let shutdown = |args: &[&str]| {
        std::process::Command::new("shutdown").args(args).spawn().map(|_| ()).map_err(|e| e.to_string())
    };
    match action {
        "shutdown" => shutdown(&["/s", "/t", "0"]),
        "restart" => shutdown(&["/r", "/t", "0"]),
        "desktop" => {
            // In the full screen experience there is no desktop under us until Windows switches to it.
            if crate::fse::active() && !crate::fse::switch(false) {
                crate::log::warn("couldn't switch Windows from the full screen experience to the desktop");
            }
            if let Some(w) = app.get_webview_window("main") {
                w.minimize().map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        // Windows then brings its home app, us, to the front.
        "home-app-settings" => crate::launcher::open_external(crate::fse::SETTINGS_PAGE),
        "fullscreen" => crate::fse::switch(true).then_some(()).ok_or_else(|| "Windows didn't switch to full screen mode".into()),
        "quit" => {
            app.exit(0);
            Ok(())
        }
        other => Err(format!("unknown action {other}")),
    }
}
