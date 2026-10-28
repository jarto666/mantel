use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use super::Scan;
use crate::model::{Art, Game, Launch};
use crate::vdf::{self, Vdf};

/// Tools and runtimes that Steam installs as "apps" but nobody wants on a game shelf.
const BLOCKED_IDS: &[u32] = &[228980, 250820, 1070560, 1391110, 1628350, 1493710, 2180100, 1826330, 1161040];

const STEAMID64_BASE: u64 = 76561197960265728;

pub fn scan() -> Scan {
    let Some(root) = steam_root() else { return Scan::default() };
    let usage = user_playtime(&root);
    let mut games = Vec::new();

    for lib in library_paths(&root) {
        let apps = lib.join("steamapps");
        let Ok(entries) = fs::read_dir(&apps) else { continue };
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().to_string();
            if !(file.starts_with("appmanifest_") && file.ends_with(".acf")) {
                continue;
            }
            let Ok(text) = fs::read_to_string(entry.path()) else { continue };
            let manifest = vdf::parse(&text);
            let Some(state) = manifest.get("AppState") else { continue };
            if let Some(game) = game_from_manifest(&root, &apps, state, &usage) {
                games.push(game);
            }
        }
    }

    Scan { games, asset_dirs: vec![root.join("appcache").join("librarycache")] }
}

fn game_from_manifest(root: &Path, apps: &Path, state: &Vdf, usage: &HashMap<u32, (u64, i64)>) -> Option<Game> {
    let appid: u32 = state.str("appid")?.parse().ok()?;
    let name = state.str("name")?.trim().to_string();
    let flags: u32 = state.str("StateFlags").and_then(|s| s.parse().ok()).unwrap_or(0);
    // Bit 4 = fully installed; other bits (update queued, etc.) may ride along.
    if flags & 4 == 0 || is_blocked(appid, &name) {
        return None;
    }

    let mut game = Game::new("steam", appid.to_string(), name, Launch::Uri { uri: format!("steam://rungameid/{appid}") });
    if let Some(dir) = state.str("installdir") {
        game.install_dir = Some(apps.join("common").join(dir).to_string_lossy().to_string());
    }
    game.size_bytes = state.str("SizeOnDisk").and_then(|s| s.parse().ok());
    game.steam_app_id = Some(appid);
    game.art = local_art(root, appid);
    game.art.extend(&cdn_art(appid));
    if let Some(&(minutes, last)) = usage.get(&appid) {
        game.playtime_minutes = minutes;
        game.last_played = (last > 0).then_some(last);
    }
    Some(game)
}

fn is_blocked(appid: u32, name: &str) -> bool {
    let n = name.to_lowercase();
    BLOCKED_IDS.contains(&appid)
        || n.contains("redistributable")
        || n.contains("steamworks")
        || n.contains("steam linux runtime")
        || n.contains("dedicated server")
        || n.starts_with("proton ")
}

/// Art served by Steam's public CDN. Works for most titles; newer ones may only have header art.
pub fn cdn_art(appid: u32) -> Art {
    let base = format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{appid}");
    Art {
        cover: vec![format!("{base}/library_600x900_2x.jpg"), format!("{base}/library_600x900.jpg")],
        hero: vec![format!("{base}/library_hero.jpg"), format!("{base}/header.jpg")],
        logo: vec![format!("{base}/logo.png")],
        icon: vec![format!("{base}/header.jpg")],
    }
}

/// Images Steam already downloaded into its library cache: instant and available offline.
fn local_art(root: &Path, appid: u32) -> Art {
    let cache = root.join("appcache").join("librarycache");
    let mut found: Vec<PathBuf> = Vec::new();

    // Current layout: librarycache/<appid>/[<hash>/]<name>
    collect_files(&cache.join(appid.to_string()), 2, &mut found);
    // Legacy layout: librarycache/<appid>_<name>
    for name in ["library_600x900_2x.jpg", "library_600x900.jpg", "library_hero.jpg", "logo.png", "header.jpg"] {
        let p = cache.join(format!("{appid}_{name}"));
        if p.is_file() {
            found.push(p);
        }
    }

    let pick = |names: &[&str]| -> Vec<String> {
        names
            .iter()
            .flat_map(|want| {
                found.iter().filter(move |p| {
                    let f = p.file_name().map(|f| f.to_string_lossy().to_lowercase()).unwrap_or_default();
                    f == *want || f.ends_with(&format!("_{want}"))
                })
            })
            .map(|p| p.to_string_lossy().to_string())
            .collect()
    };

    Art {
        cover: pick(&["library_600x900_2x.jpg", "library_600x900.jpg", "library_capsule.jpg"]),
        hero: pick(&["library_hero.jpg"]),
        logo: pick(&["logo_2x.png", "logo.png"]),
        icon: pick(&["header.jpg"]),
    }
}

fn collect_files(dir: &Path, depth: u32, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 1 {
                collect_files(&path, depth - 1, out);
            }
        } else {
            out.push(path);
        }
    }
}

fn library_paths(root: &Path) -> Vec<PathBuf> {
    let mut out = vec![root.to_path_buf()];
    let Ok(text) = fs::read_to_string(root.join("steamapps").join("libraryfolders.vdf")) else { return out };
    let parsed = vdf::parse(&text);
    let Some(folders) = parsed.get("libraryfolders") else { return out };
    for (_, entry) in folders.entries() {
        // Newer files nest `{ "path" … }`; older ones map index → path directly.
        let path = entry.str("path").or_else(|| entry.as_str());
        if let Some(p) = path {
            let p = PathBuf::from(p);
            let key = p.to_string_lossy().to_lowercase();
            if !out.iter().any(|o| o.to_string_lossy().to_lowercase() == key) {
                out.push(p);
            }
        }
    }
    out
}

/// Steam's own playtime (minutes) and last-played time per app for the active account.
fn user_playtime(root: &Path) -> HashMap<u32, (u64, i64)> {
    let mut out = HashMap::new();
    let Some(config) = local_config_path(root) else { return out };
    let Ok(text) = fs::read_to_string(config) else { return out };
    let parsed = vdf::parse(&text);
    let Some(apps) = parsed.path(&["UserLocalConfigStore", "Software", "Valve", "Steam", "apps"]) else { return out };
    for (key, app) in apps.entries() {
        let Ok(appid) = key.parse::<u32>() else { continue };
        let minutes = app.str("Playtime").and_then(|s| s.parse().ok()).unwrap_or(0);
        let last = app.str("LastPlayed").and_then(|s| s.parse().ok()).unwrap_or(0);
        if minutes > 0 || last > 0 {
            out.insert(appid, (minutes, last));
        }
    }
    out
}

/// The account Steam last signed in with: SteamID64 and persona name.
pub fn current_user() -> Option<(u64, String)> {
    let root = steam_root()?;
    recent_user(&root)
}

fn recent_user(root: &Path) -> Option<(u64, String)> {
    let text = fs::read_to_string(root.join("config").join("loginusers.vdf")).ok()?;
    let parsed = vdf::parse(&text);
    let (id, user) = parsed.get("users")?.entries().iter().max_by_key(|(_, u)| {
        let most_recent = u.str("MostRecent") == Some("1");
        let ts: u64 = u.str("Timestamp").and_then(|s| s.parse().ok()).unwrap_or(0);
        (most_recent, ts)
    })?;
    Some((id.parse().ok()?, user.str("PersonaName").unwrap_or_default().to_string()))
}

fn local_config_path(root: &Path) -> Option<PathBuf> {
    let userdata = root.join("userdata");

    if let Some((id64, _)) = recent_user(root) {
        let p = userdata.join((id64.saturating_sub(STEAMID64_BASE)).to_string()).join("config").join("localconfig.vdf");
        if p.is_file() {
            return Some(p);
        }
    }

    // Fall back to whichever account touched its config last.
    fs::read_dir(&userdata)
        .ok()?
        .flatten()
        .map(|e| e.path().join("config").join("localconfig.vdf"))
        .filter(|p| p.is_file())
        .max_by_key(|p| fs::metadata(p).and_then(|m| m.modified()).ok())
}

#[cfg(windows)]
fn steam_root() -> Option<PathBuf> {
    use super::reg;
    reg::hkcu_str(r"Software\Valve\Steam", "SteamPath")
        .map(|p| PathBuf::from(p.replace('/', "\\")))
        .filter(|p| p.is_dir())
        .or_else(|| reg::hklm_str(r"SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath").map(PathBuf::from).filter(|p| p.is_dir()))
        .or_else(|| Some(PathBuf::from(r"C:\Program Files (x86)\Steam")).filter(|p| p.is_dir()))
}

#[cfg(not(windows))]
fn steam_root() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    [home.join("Library/Application Support/Steam"), home.join(".steam/steam"), home.join(".local/share/Steam")]
        .into_iter()
        .find(|p| p.join("steamapps").is_dir())
}
