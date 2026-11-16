//! Finding a game to add by hand, from a gamepad: shortcut suggestions and a file browser.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    /// "drive", "place", "dir", "exe", "lnk", "url", "bat" or "image".
    pub kind: String,
    pub size: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    /// None for the top level (drives and common places).
    pub path: Option<String>,
    pub parent: Option<String>,
    pub entries: Vec<Entry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Suggestion {
    pub name: String,
    /// The shortcut itself, so it launches with its own arguments and working folder.
    pub path: String,
    pub target: String,
}

const PICKABLE: &[&str] = &["exe", "lnk", "url", "bat", "cmd"];
pub const IMAGES: &[&str] = &["png", "jpg", "jpeg", "webp"];

/// Folders and launchable files, or with `images` folders and pictures (for picking art).
pub fn list_dir(path: Option<&str>, images: bool) -> Result<Listing, String> {
    let Some(path) = path else { return Ok(top_level(images)) };
    let dir = Path::new(path);
    let read = std::fs::read_dir(dir).map_err(|e| format!("Can't open {path}: {e}"))?;
    let mut entries: Vec<Entry> = read
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with('$') {
                return None;
            }
            let meta = e.metadata().ok()?;
            if meta.is_dir() {
                return Some(Entry { name, path: p.to_string_lossy().to_string(), kind: "dir".into(), size: None });
            }
            let ext = p.extension()?.to_string_lossy().to_lowercase();
            let kind = match ext.as_str() {
                e if images && IMAGES.contains(&e) => "image".to_string(),
                _ if images => return None,
                "cmd" => "bat".into(),
                e if PICKABLE.contains(&e) => ext.clone(),
                _ => return None,
            };
            Some(Entry { name, path: p.to_string_lossy().to_string(), kind, size: Some(meta.len()) })
        })
        .collect();
    // Folders first; then the biggest executables, which are usually the game itself, or
    // pictures by name.
    entries.sort_by(|a, b| {
        let rank = |e: &Entry| if e.kind == "dir" { 0 } else { 1 };
        rank(a).cmp(&rank(b)).then_with(|| match a.kind.as_str() {
            "dir" | "image" => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            _ => b.size.cmp(&a.size),
        })
    });
    Ok(Listing {
        path: Some(path.to_string()),
        parent: Some(dir.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()).filter(|p| !p.is_empty()),
        entries,
    })
}

fn top_level(images: bool) -> Listing {
    let mut entries = Vec::new();
    let mut place = |name: &str, path: PathBuf| {
        if path.is_dir() {
            entries.push(Entry { name: name.into(), path: path.to_string_lossy().to_string(), kind: "place".into(), size: None });
        }
    };
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from) {
        if images {
            place("Pictures", home.join("Pictures"));
        }
        place("Desktop", home.join("Desktop"));
        place("Downloads", home.join("Downloads"));
    }
    #[cfg(windows)]
    {
        for letter in (b'C'..=b'Z').filter(|_| !images) {
            let root = format!("{}:\\", letter as char);
            for sub in ["Games", "XboxGames", "SteamLibrary", "Program Files", "Program Files (x86)"] {
                place(&format!("{sub} ({}:)", letter as char), PathBuf::from(&root).join(sub));
            }
        }
        for letter in b'A'..=b'Z' {
            let root = format!("{}:\\", letter as char);
            if Path::new(&root).is_dir() {
                entries.push(Entry { name: format!("Drive {}:", letter as char), path: root, kind: "drive".into(), size: None });
            }
        }
    }
    #[cfg(not(windows))]
    entries.push(Entry { name: "Computer".into(), path: "/".into(), kind: "drive".into(), size: None });
    Listing { path: None, parent: None, entries }
}

#[cfg(windows)]
/// Engines and store SDKs ship next to a game's exe; office apps, browsers and tools have none.
const GAME_MARKERS: &[&str] = &[
    "UnityPlayer.dll", "GameAssembly.dll", "steam_api64.dll", "steam_api.dll", "EOSSDK-Win64-Shipping.dll",
    "galaxy64.dll", "galaxy.dll", "bink2w64.dll", "binkw64.dll", "binkw32.dll", "fmod.dll", "fmodstudio.dll",
    "nvngx_dlss.dll", "PhysX3_x64.dll", "openvr_api.dll",
];

#[cfg(windows)]
/// Checks the exe's folder and a few above it: Unreal keeps the exe in Binaries\Win64.
fn looks_like_game(exe: &Path) -> bool {
    let stem = exe.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    exe.ancestors().skip(1).take(4).any(|dir| {
        GAME_MARKERS.iter().any(|m| dir.join(m).is_file())
            || dir.join("Engine").join("Binaries").is_dir()
            || dir.join(format!("{stem}_Data")).is_dir()
    })
}

/// Store apps ship the same SDKs as their games, but Mantel already covers them.
#[cfg(windows)]
const LAUNCHERS: &[&str] = &[
    "\\steam.exe", "\\epicgameslauncher.exe", "\\galaxyclient.exe", "\\upc.exe", "\\ubisoftconnect.exe",
    "\\eadesktop.exe", "\\battle.net.exe", "\\battle.net launcher.exe", "\\playnite.desktopapp.exe",
];

/// Start menu and desktop shortcuts to games, minus tools, docs and uninstallers.
#[cfg(windows)]
pub fn suggestions(known_dirs: &[String]) -> Vec<Suggestion> {
    const QUERY: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell
$roots = @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs", [Environment]::GetFolderPath('Desktop'), "$env:PUBLIC\Desktop")
$out = foreach ($r in $roots) {
  if (Test-Path -LiteralPath $r) {
    Get-ChildItem -LiteralPath $r -Recurse -Filter *.lnk | ForEach-Object {
      $t = $sh.CreateShortcut($_.FullName).TargetPath
      if ($t -like '*.exe') { [pscustomobject]@{ name = $_.BaseName; path = $_.FullName; target = $t } }
    }
  }
}
ConvertTo-Json -InputObject @($out) -Compress
"#;
    let Some(text) = powershell(QUERY) else { return Vec::new() };
    let Ok(mut found) = serde_json::from_str::<Vec<Suggestion>>(text.trim().trim_start_matches('\u{feff}')) else { return Vec::new() };
    let junk = [
        "uninstall", "readme", "help", "manual", "website", "support", "update", "setup", "config", "settings",
        "crash", "report", "license", "documentation", "release notes", "changelog", "feedback", "redist",
    ];
    let known: Vec<String> = known_dirs.iter().map(|d| d.to_lowercase()).collect();
    found.retain(|s| {
        let name = s.name.to_lowercase();
        let target = s.target.to_lowercase();
        !junk.iter().any(|j| name.contains(j))
            && !target.starts_with(r"c:\windows")
            && Path::new(&s.target).is_file()
            && !known.iter().any(|d| target.starts_with(d.as_str()))
            && !LAUNCHERS.iter().any(|l| target.ends_with(l))
            && looks_like_game(Path::new(&s.target))
    });
    found.sort_by_key(|s| s.name.to_lowercase());
    found.dedup_by(|a, b| a.target.eq_ignore_ascii_case(&b.target));
    found
}

#[cfg(not(windows))]
pub fn suggestions(_known_dirs: &[String]) -> Vec<Suggestion> {
    Vec::new()
}

/// Product name from the exe's version resource, e.g. "Dying Light 2 Stay Human".
#[cfg(windows)]
pub fn product_name(exe: &str) -> Option<String> {
    let escaped = exe.replace('\'', "''");
    let script = format!(
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $v = (Get-Item -LiteralPath '{escaped}').VersionInfo; if ($v.ProductName) {{ $v.ProductName }} else {{ $v.FileDescription }}"
    );
    let name = powershell(&script)?.trim().trim_start_matches('\u{feff}').to_string();
    // Engine boilerplate is not a game name.
    let generic = ["unreal engine", "unity", "bootstrap", "launcher", "game"];
    (!name.is_empty() && !generic.contains(&name.to_lowercase().as_str())).then_some(name)
}

#[cfg(not(windows))]
pub fn product_name(_exe: &str) -> Option<String> {
    None
}

/// What a shortcut runs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Shortcut {
    pub target: String,
    /// As written in the shortcut, to be passed on as they are.
    pub arguments: String,
    pub working_dir: String,
    /// Set to run as administrator, which only the shell can ask for.
    pub elevated: bool,
}

/// Reads a shortcut through the Shell's own interface. WScript.Shell loses characters like the ’
/// in "Kirby’s", and PowerShell takes that ’ for a quote, so shortcuts named after such a game
/// couldn't be read at all.
#[cfg(windows)]
pub fn shortcut(lnk: &str) -> Option<Shortcut> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ};
    use windows::Win32::UI::Shell::{IShellLinkDataList, IShellLinkW, ShellLink, SLDF_RUNAS_USER};

    let path: Vec<u16> = std::ffi::OsStr::new(lnk).encode_wide().chain(Some(0)).collect();
    // COM on a thread of its own: the caller's may be set up for something else.
    std::thread::spawn(move || unsafe {
        let ready = CoInitializeEx(None, COINIT_APARTMENTTHREADED).is_ok();
        let read = || -> windows::core::Result<Shortcut> {
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
            link.cast::<IPersistFile>()?.Load(PCWSTR(path.as_ptr()), STGM_READ)?;
            let mut buf = vec![0u16; 32_768];
            let mut text = |get: &dyn Fn(&mut [u16]) -> windows::core::Result<()>| -> windows::core::Result<String> {
                buf.fill(0);
                get(&mut buf)?;
                Ok(String::from_utf16_lossy(&buf[..buf.iter().position(|&c| c == 0).unwrap_or(buf.len())]))
            };
            let target = text(&|b| link.GetPath(b, std::ptr::null_mut(), 0))?;
            let arguments = text(&|b| link.GetArguments(b))?;
            let working_dir = text(&|b| link.GetWorkingDirectory(b))?;
            let flags = link.cast::<IShellLinkDataList>().and_then(|d| d.GetFlags()).unwrap_or(0);
            Ok(Shortcut { target, arguments, working_dir, elevated: flags & SLDF_RUNAS_USER.0 as u32 != 0 })
        };
        let shortcut = read();
        if ready {
            CoUninitialize();
        }
        shortcut.map_err(|e| crate::log::warn(&format!("shortcut not read: {e}"))).ok()
    })
    .join()
    .ok()
    .flatten()
}

#[cfg(not(windows))]
pub fn shortcut(_lnk: &str) -> Option<Shortcut> {
    None
}

/// Where a shortcut points.
pub fn shortcut_target(lnk: &str) -> Option<String> {
    shortcut(lnk).map(|s| s.target).filter(|t| !t.is_empty())
}

/// Runs a PowerShell script without a window and returns what it printed.
#[cfg(windows)]
pub(crate) fn run_powershell(script: &str) -> Option<String> {
    powershell(script)
}

#[cfg(all(test, windows))]
pub(crate) mod tests {
    use super::*;

    /// Writes a shortcut the way Eden does for a game, named after it.
    pub(crate) fn save(lnk: &std::path::Path, target: &str, arguments: &str, dir: &str) {
        use windows::core::{Interface, HSTRING};
        use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED};
        use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};
        let (lnk, target, arguments, dir) = (HSTRING::from(lnk.as_os_str()), HSTRING::from(target), HSTRING::from(arguments), HSTRING::from(dir));
        std::thread::spawn(move || unsafe {
            CoInitializeEx(None, COINIT_APARTMENTTHREADED).unwrap();
            let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).unwrap();
            link.SetPath(&target).unwrap();
            link.SetArguments(&arguments).unwrap();
            link.SetWorkingDirectory(&dir).unwrap();
            link.cast::<IPersistFile>().unwrap().Save(&lnk, true).unwrap();
            drop(link);
            CoUninitialize();
        })
        .join()
        .unwrap();
    }

    #[test]
    fn reads_a_shortcut_named_with_a_curly_apostrophe() {
        let dir = std::env::temp_dir().join(format!("mantel-lnk-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let lnk = dir.join("Kirby’s Return to Dream Land Deluxe.lnk");
        let arguments = r#"-f -g "C:/ROMS\Kirby’s Return to Dream Land Deluxe [01006B601380E000].xci""#;
        save(&lnk, r"C:\Eden\eden.exe", arguments, r"C:\Eden");
        let read = shortcut(lnk.to_str().unwrap());
        std::fs::remove_dir_all(&dir).unwrap();
        let read = read.unwrap();
        assert_eq!((read.target.as_str(), read.arguments.as_str(), read.working_dir.as_str(), read.elevated), (r"C:\Eden\eden.exe", arguments, r"C:\Eden", false));
    }
}

#[cfg(windows)]
fn powershell(script: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}
