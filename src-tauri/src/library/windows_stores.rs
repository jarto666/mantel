//! Stores that only exist on Windows: GOG, Xbox / Microsoft Store, Ubisoft Connect.

use std::path::{Path, PathBuf};

use serde::Deserialize;

use super::{reg, Scan};
use crate::model::{Game, Launch};

pub fn scan_gog() -> Scan {
    let Some(root) = reg::hklm(r"SOFTWARE\WOW6432Node\GOG.com\Games") else { return Scan::default() };
    let galaxy = reg::hklm_str(r"SOFTWARE\WOW6432Node\GOG.com\GalaxyClient\paths", "client")
        .map(|dir| PathBuf::from(dir).join("GalaxyClient.exe"))
        .filter(|p| p.is_file());

    let mut games = Vec::new();
    for key in root.enum_keys().flatten() {
        let Ok(sub) = root.open_subkey(&key) else { continue };
        let get = |name: &str| sub.get_value::<String, _>(name).unwrap_or_default();
        let (name, path, id) = (get("gameName"), get("path"), get("gameID"));
        let id = if id.is_empty() { key.clone() } else { id };
        // DLC and add-ons declare the game they extend.
        if name.is_empty() || !Path::new(&path).is_dir() || !get("dependsOn").trim().is_empty() {
            continue;
        }

        let launch = match &galaxy {
            // Through Galaxy so cloud saves and the overlay keep working.
            Some(client) => Launch::Exe {
                path: client.to_string_lossy().to_string(),
                args: vec!["/command=runGame".into(), format!("/gameId={id}"), format!("/path={path}")],
                cwd: client.parent().map(|p| p.to_string_lossy().to_string()),
            },
            None => {
                let exe = get("exe");
                if exe.is_empty() {
                    continue;
                }
                let cwd = get("workingDir");
                Launch::Exe {
                    path: exe,
                    args: get("launchParam").split_whitespace().map(String::from).collect(),
                    cwd: Some(if cwd.is_empty() { path.clone() } else { cwd }),
                }
            }
        };
        let mut game = Game::new("gog", id, name, launch);
        game.exe_names.extend(crate::model::exe_name(&get("exe")));
        game.install_dir = Some(path);
        games.push(game);
    }
    Scan { games, asset_dirs: Vec::new() }
}

pub fn scan_ubisoft() -> Scan {
    let Some(root) = reg::hklm(r"SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs") else { return Scan::default() };
    let mut games = Vec::new();
    for id in root.enum_keys().flatten() {
        let Ok(sub) = root.open_subkey(&id) else { continue };
        let dir: String = sub.get_value("InstallDir").unwrap_or_default();
        let dir = dir.replace('/', "\\");
        if !Path::new(&dir).is_dir() {
            continue;
        }
        let name = reg::hklm_str(&format!(r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Uplay Install {id}"), "DisplayName")
            .filter(|n| !n.is_empty())
            .or_else(|| Path::new(dir.trim_end_matches('\\')).file_name().map(|n| n.to_string_lossy().to_string()));
        let Some(name) = name else { continue };
        let mut game = Game::new("ubisoft", id.clone(), name, Launch::Uri { uri: format!("uplay://launch/{id}/0") });
        game.install_dir = Some(dir);
        games.push(game);
    }
    Scan { games, asset_dirs: Vec::new() }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppxGame {
    family: String,
    location: String,
    app_id: Option<String>,
    display: Option<String>,
}

/// Packages that ship a MicrosoftGame.config are GDK games (Game Pass, Xbox app, Store).
const XBOX_QUERY: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$out = foreach ($p in Get-AppxPackage) {
  $loc = $p.InstallLocation
  if (-not $loc -or -not (Test-Path -LiteralPath (Join-Path $loc 'MicrosoftGame.config'))) { continue }
  $m = Get-AppxPackageManifest -Package $p.PackageFullName
  $app = @($m.Package.Applications.Application)[0]
  [pscustomobject]@{ family = $p.PackageFamilyName; location = $loc; appId = $app.Id; display = $m.Package.Properties.DisplayName }
}
ConvertTo-Json -InputObject @($out) -Compress
"#;

pub fn scan_xbox() -> Scan {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let output = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", XBOX_QUERY])
        .creation_flags(CREATE_NO_WINDOW)
        .output();
    let Ok(output) = output else { return Scan::default() };
    let text = String::from_utf8_lossy(&output.stdout);
    let Ok(found) = serde_json::from_str::<Vec<AppxGame>>(text.trim().trim_start_matches('\u{feff}')) else { return Scan::default() };

    let mut scan = Scan::default();
    for pkg in found {
        let loc = PathBuf::from(&pkg.location);
        let visuals = read_shell_visuals(&loc.join("MicrosoftGame.config"));
        let name = [visuals.name.clone(), pkg.display.clone()]
            .into_iter()
            .flatten()
            .find(|n| !n.is_empty() && !n.starts_with("ms-resource:"))
            .or_else(|| folder_name(&loc));
        let Some(name) = name else { continue };
        let app_id = pkg.app_id.unwrap_or_else(|| "Game".into());

        let mut game = Game::new(
            "xbox",
            pkg.family.clone(),
            name,
            Launch::Uri { uri: format!(r"shell:AppsFolder\{}!{app_id}", pkg.family) },
        );
        game.install_dir = Some(pkg.location.clone());
        game.exe_names = visuals.executables.iter().filter_map(|e| crate::model::exe_name(e)).collect();
        let file = |rel: &Option<String>| rel.as_ref().map(|r| loc.join(r)).filter(|p| p.is_file()).map(|p| p.to_string_lossy().to_string());
        game.art.cover.extend(file(&visuals.square480));
        game.art.hero.extend(file(&visuals.splash));
        game.art.icon.extend(file(&visuals.square150).or_else(|| file(&visuals.store_logo)));
        scan.asset_dirs.push(loc);
        scan.games.push(game);
    }
    scan
}

#[derive(Default)]
struct ShellVisuals {
    name: Option<String>,
    executables: Vec<String>,
    square480: Option<String>,
    square150: Option<String>,
    store_logo: Option<String>,
    splash: Option<String>,
}

fn read_shell_visuals(path: &Path) -> ShellVisuals {
    let Ok(text) = std::fs::read_to_string(path) else { return ShellVisuals::default() };
    let Ok(doc) = roxmltree::Document::parse(text.trim_start_matches('\u{feff}')) else { return ShellVisuals::default() };
    let Some(node) = doc.descendants().find(|n| n.has_tag_name("ShellVisuals")) else { return ShellVisuals::default() };
    let attr = |name: &str| node.attribute(name).map(String::from);
    let executables = doc
        .descendants()
        .filter(|n| n.has_tag_name("Executable"))
        .filter_map(|n| n.attribute("Name").map(String::from))
        .collect();
    ShellVisuals {
        name: attr("DefaultDisplayName"),
        executables,
        square480: attr("Square480x480Logo"),
        square150: attr("Square150x150Logo"),
        store_logo: attr("StoreLogo"),
        splash: attr("SplashScreenImage"),
    }
}

/// `C:\XboxGames\Halo Infinite\Content` → "Halo Infinite". WindowsApps folder names are
/// package ids, so those get no fallback.
fn folder_name(loc: &Path) -> Option<String> {
    if !loc.file_name()?.eq_ignore_ascii_case("Content") {
        return None;
    }
    loc.parent()?.file_name().map(|n| n.to_string_lossy().to_string())
}
