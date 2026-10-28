//! Finding a game to add by hand, from a gamepad: shortcut suggestions and a file browser.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    /// "drive", "place", "dir", "exe", "lnk", "url" or "bat".
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

pub fn list_dir(path: Option<&str>) -> Result<Listing, String> {
    let Some(path) = path else { return Ok(top_level()) };
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
            PICKABLE.contains(&ext.as_str()).then(|| Entry {
                name,
                path: p.to_string_lossy().to_string(),
                kind: if ext == "cmd" { "bat".into() } else { ext },
                size: Some(meta.len()),
            })
        })
        .collect();
    // Folders first; then the biggest executables, which are usually the game itself.
    entries.sort_by(|a, b| {
        let rank = |e: &Entry| if e.kind == "dir" { 0 } else { 1 };
        rank(a).cmp(&rank(b)).then_with(|| match a.kind.as_str() {
            "dir" => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            _ => b.size.cmp(&a.size),
        })
    });
    Ok(Listing {
        path: Some(path.to_string()),
        parent: Some(dir.parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default()).filter(|p| !p.is_empty()),
        entries,
    })
}

fn top_level() -> Listing {
    let mut entries = Vec::new();
    let mut place = |name: &str, path: PathBuf| {
        if path.is_dir() {
            entries.push(Entry { name: name.into(), path: path.to_string_lossy().to_string(), kind: "place".into(), size: None });
        }
    };
    if let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from) {
        place("Desktop", home.join("Desktop"));
        place("Downloads", home.join("Downloads"));
    }
    #[cfg(windows)]
    {
        for letter in b'C'..=b'Z' {
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

/// Where a shortcut points.
#[cfg(windows)]
pub fn shortcut_target(lnk: &str) -> Option<String> {
    let escaped = lnk.replace('\'', "''");
    let script = format!("[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (New-Object -ComObject WScript.Shell).CreateShortcut('{escaped}').TargetPath");
    let target = powershell(&script)?.trim().trim_start_matches('\u{feff}').to_string();
    (!target.is_empty()).then_some(target)
}

#[cfg(not(windows))]
pub fn shortcut_target(_lnk: &str) -> Option<String> {
    None
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
