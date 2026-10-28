use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use base64::engine::general_purpose::{GeneralPurpose, GeneralPurposeConfig};
use base64::engine::DecodePaddingMode;
use base64::{alphabet, Engine};
use serde_json::Value;

use super::Scan;
use crate::model::{Art, Game, Launch};

pub fn scan() -> Scan {
    let data = data_dir();
    let Ok(entries) = fs::read_dir(data.join("Manifests")) else { return Scan::default() };
    let catalog = load_catalog(&data.join("Catalog").join("catcache.bin"));

    let games = entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x.eq_ignore_ascii_case("item")))
        .filter_map(|e| fs::read(e.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter_map(|item| game_from_manifest(&item, &catalog))
        .collect();

    Scan { games, asset_dirs: Vec::new() }
}

fn game_from_manifest(item: &Value, catalog: &HashMap<String, Art>) -> Option<Game> {
    let s = |key: &str| item.get(key).and_then(Value::as_str).unwrap_or_default();
    let app = s("AppName");
    let name = s("DisplayName");
    let location = s("InstallLocation");
    if app.is_empty() || name.is_empty() || !Path::new(location).is_dir() {
        return None;
    }
    // DLC manifests point at their parent through MainGameAppName.
    let main = s("MainGameAppName");
    if !main.is_empty() && main != app {
        return None;
    }
    if item.get("bIsIncompleteInstall").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    if let Some(cats) = item.get("AppCategories").and_then(Value::as_array) {
        if !cats.is_empty() && !cats.iter().any(|c| c.as_str() == Some("games")) {
            return None;
        }
    }

    let (ns, catalog_id) = (s("CatalogNamespace"), s("CatalogItemId"));
    let uri = if ns.is_empty() || catalog_id.is_empty() {
        format!("com.epicgames.launcher://apps/{app}?action=launch&silent=true")
    } else {
        format!("com.epicgames.launcher://apps/{ns}%3A{catalog_id}%3A{app}?action=launch&silent=true")
    };

    let mut game = Game::new("epic", app, name, Launch::Uri { uri });
    game.install_dir = Some(location.to_string());
    game.exe_names.extend(crate::model::exe_name(s("LaunchExecutable")));
    game.size_bytes = item.get("InstallSize").and_then(Value::as_u64);
    if let Some(art) = catalog.get(catalog_id) {
        game.art = art.clone();
    }
    Some(game)
}

/// The launcher's offline catalog cache: base64-encoded JSON with each item's key art.
fn load_catalog(path: &Path) -> HashMap<String, Art> {
    let mut out = HashMap::new();
    let Ok(raw) = fs::read(path) else { return out };
    let clean: Vec<u8> = raw.into_iter().filter(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'=')).collect();
    let engine = GeneralPurpose::new(
        &alphabet::STANDARD,
        GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
    );
    let Ok(json) = engine.decode(clean) else { return out };
    let Ok(Value::Array(items)) = serde_json::from_slice::<Value>(&json) else { return out };

    for item in items {
        let Some(id) = item.get("id").and_then(Value::as_str) else { continue };
        let Some(images) = item.get("keyImages").and_then(Value::as_array) else { continue };
        let mut art = Art::default();
        for img in images {
            let (Some(kind), Some(url)) = (img.get("type").and_then(Value::as_str), img.get("url").and_then(Value::as_str)) else {
                continue;
            };
            match kind {
                "DieselGameBoxTall" | "OfferImageTall" => art.cover.push(sized(url, 600, 900)),
                "DieselGameBox" | "OfferImageWide" | "DieselStoreFrontWide" => art.hero.push(sized(url, 1920, 1080)),
                "DieselGameBoxLogo" => art.logo.push(url.to_string()),
                "Thumbnail" => art.icon.push(url.to_string()),
                _ => {}
            }
        }
        out.insert(id.to_string(), art);
    }
    out
}

/// Epic's image CDN resizes on request; originals can be several megabytes.
fn sized(url: &str, w: u32, h: u32) -> String {
    if url.contains('?') {
        url.to_string()
    } else {
        format!("{url}?w={w}&h={h}&resize=1&quality=high")
    }
}

fn data_dir() -> PathBuf {
    #[cfg(windows)]
    if let Some(p) = super::reg::hklm_str(r"SOFTWARE\WOW6432Node\Epic Games\EpicGamesLauncher", "AppDataPath") {
        let p = PathBuf::from(p);
        if p.is_dir() {
            return p;
        }
    }
    let program_data = std::env::var_os("PROGRAMDATA").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"));
    program_data.join("Epic").join("EpicGamesLauncher").join("Data")
}
