use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::model::{Art, Game};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Sources {
    pub steam: bool,
    pub epic: bool,
    pub gog: bool,
    pub xbox: bool,
    pub ubisoft: bool,
}

impl Default for Sources {
    fn default() -> Self {
        Sources { steam: true, epic: true, gog: true, xbox: true, ubisoft: true }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub sources: Sources,
    pub steamgriddb_key: String,
    pub sounds: bool,
    pub minimize_on_launch: bool,
    /// Muted trailers behind the focused game on Home.
    pub trailers: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            sources: Sources::default(),
            steamgriddb_key: String::new(),
            sounds: true,
            minimize_on_launch: true,
            trailers: true,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GameMeta {
    pub favorite: bool,
    pub hidden: bool,
    /// Minutes Mantel measured itself, summed across sessions.
    pub tracked_minutes: u64,
    pub last_played: Option<i64>,
    pub added_at: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomGame {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub args: Vec<String>,
    /// For shortcuts: the exe they point at, which is what shows up as a running process.
    #[serde(default)]
    pub target: Option<String>,
}

/// Store sign-ins. Kept out of `Settings` so tokens never travel to the UI.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Accounts {
    /// Signed in to Steam in Mantel's WebView; the session itself lives in its cookie jar.
    pub steam_signed_in: bool,
    /// Short-lived Steam Web API token, renewed as it expires.
    pub steam_token: String,
    /// Microsoft refresh token for Xbox Live; rotated on every use.
    pub xbox_refresh: String,
    pub xbox_gamertag: String,
    /// Cached XSTS token, good for about a day.
    pub xbox_session: crate::accounts::XboxSession,
}

/// Everything the user created: lost data here is lost for good.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UserData {
    pub settings: Settings,
    pub meta: HashMap<String, GameMeta>,
    pub custom: Vec<CustomGame>,
    pub accounts: Accounts,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ResolvedArt {
    pub art: Art,
    pub steam_app_id: Option<u32>,
    pub at: i64,
}

/// Rebuildable data: the last scan and lookups against online services.
#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Cache {
    pub library: Vec<Game>,
    pub asset_dirs: Vec<PathBuf>,
    pub art: HashMap<String, ResolvedArt>,
    pub details: HashMap<u32, serde_json::Value>,
    /// Last good answer from each store account, used when it can't be reached.
    pub owned_steam: Vec<crate::accounts::OwnedSteam>,
    pub owned_xbox: Vec<crate::accounts::XboxTitle>,
}

pub struct AppState {
    dir: PathBuf,
    pub user: Mutex<UserData>,
    pub cache: Mutex<Cache>,
    pub running: Mutex<Option<crate::launcher::Running>>,
}

const USER_FILE: &str = "user.json";
const CACHE_FILE: &str = "cache.json";

impl AppState {
    pub fn load(dir: PathBuf) -> Self {
        AppState {
            user: Mutex::new(read_json(&dir.join(USER_FILE))),
            cache: Mutex::new(read_json(&dir.join(CACHE_FILE))),
            running: Mutex::new(None),
            dir,
        }
    }

    pub fn save_user(&self, user: &UserData) {
        write_json(&self.dir.join(USER_FILE), user);
    }

    pub fn save_cache(&self, cache: &Cache) {
        write_json(&self.dir.join(CACHE_FILE), cache);
    }
}

fn read_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Writes through a temp file so a crash mid-write never truncates the original.
fn write_json<T: Serialize>(path: &Path, value: &T) {
    let Ok(bytes) = serde_json::to_vec(value) else { return };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, bytes).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}
