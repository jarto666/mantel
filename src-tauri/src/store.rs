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

/// Store sign-ins. Kept out of `Settings` so tokens never travel to the UI, and encrypted on
/// disk (see [`secret`]).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Accounts {
    /// Signed in to Steam in Mantel's WebView; the session itself lives in its cookie jar.
    pub steam_signed_in: bool,
    /// Short-lived Steam Web API token, renewed as it expires.
    #[serde(with = "secret")]
    pub steam_token: String,
    /// Microsoft refresh token for Xbox Live; rotated on every use.
    #[serde(with = "secret")]
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MeasuredSize {
    pub bytes: Option<u64>,
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
    /// Install folder sizes for stores that don't report one, by install folder.
    pub sizes: HashMap<String, MeasuredSize>,
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
        let state = AppState {
            user: Mutex::new(read_json(&dir.join(USER_FILE))),
            cache: Mutex::new(read_json(&dir.join(CACHE_FILE))),
            running: Mutex::new(None),
            dir,
        };
        // Tokens saved by older versions are plain text: encrypt them right away.
        if secret::found_plain() {
            state.save_user(&state.user.lock().unwrap());
            crate::log::info("account tokens encrypted");
        }
        state
    }

    pub fn save_user(&self, user: &UserData) {
        write_json(&self.dir.join(USER_FILE), user);
    }

    pub fn save_cache(&self, cache: &Cache) {
        write_json(&self.dir.join(CACHE_FILE), cache);
    }
}

/// Account tokens in `user.json`, encrypted with DPAPI for the signed-in Windows user, so a
/// copy of the file is useless elsewhere. Plain values from before still load, and are
/// encrypted on the next save. Elsewhere (development on macOS) they stay plain.
pub mod secret {
    use std::sync::atomic::{AtomicBool, Ordering};

    use base64::engine::general_purpose::STANDARD;
    use base64::Engine;
    use serde::{Deserialize, Deserializer, Serializer};

    const PREFIX: &str = "dpapi:";
    static PLAIN: AtomicBool = AtomicBool::new(false);

    /// Whether anything loaded so far was stored in plain text.
    pub fn found_plain() -> bool {
        cfg!(windows) && PLAIN.load(Ordering::Relaxed)
    }

    pub fn serialize<S: Serializer>(value: &str, s: S) -> Result<S::Ok, S::Error> {
        if value.is_empty() {
            return s.serialize_str("");
        }
        match protect(value.as_bytes()) {
            Some(blob) => s.serialize_str(&format!("{PREFIX}{}", STANDARD.encode(blob))),
            // Better on disk as it was than signed out.
            None => s.serialize_str(value),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<String, D::Error> {
        let raw = String::deserialize(d)?;
        Ok(match raw.strip_prefix(PREFIX) {
            // Unreadable here (another user or PC): as good as signed out.
            Some(blob) => STANDARD.decode(blob).ok().and_then(|b| unprotect(&b)).and_then(|b| String::from_utf8(b).ok()).unwrap_or_default(),
            None => {
                if !raw.is_empty() {
                    PLAIN.store(true, Ordering::Relaxed);
                }
                raw
            }
        })
    }

    #[cfg(windows)]
    fn crypt(data: &[u8], encrypt: bool) -> Option<Vec<u8>> {
        use std::ptr::{null, null_mut};
        use windows_sys::Win32::Foundation::LocalFree;
        use windows_sys::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};
        let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
        let mut out = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
        let ok = unsafe {
            if encrypt {
                CryptProtectData(&input, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            } else {
                CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut out)
            }
        };
        if ok == 0 || out.pbData.is_null() {
            crate::log::warn(&format!("DPAPI {} failed", if encrypt { "encryption" } else { "decryption" }));
            return None;
        }
        let bytes = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
        unsafe { LocalFree(out.pbData as _) };
        Some(bytes)
    }

    #[cfg(windows)]
    fn protect(data: &[u8]) -> Option<Vec<u8>> {
        crypt(data, true)
    }

    #[cfg(windows)]
    fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        crypt(data, false)
    }

    #[cfg(not(windows))]
    fn protect(_: &[u8]) -> Option<Vec<u8>> {
        None
    }

    #[cfg(not(windows))]
    fn unprotect(_: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

fn read_json<T: DeserializeOwned + Default>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_tokens_secret() {
        let mut user = UserData::default();
        user.accounts.steam_token = "steam-jwt".into();
        user.accounts.xbox_refresh = "M.refresh".into();
        user.accounts.xbox_session.token = "xsts".into();
        let json = serde_json::to_string(&user).unwrap();
        if cfg!(windows) {
            assert!(!json.contains("steam-jwt") && !json.contains("M.refresh") && !json.contains("\"xsts\""));
        }
        let back: UserData = serde_json::from_str(&json).unwrap();
        assert_eq!(back.accounts.steam_token, "steam-jwt");
        assert_eq!(back.accounts.xbox_refresh, "M.refresh");
        assert_eq!(back.accounts.xbox_session.token, "xsts");

        // Plain values from older versions load as they are; broken blobs mean signed out.
        let old: UserData = serde_json::from_str(r#"{"accounts":{"steamToken":"plain","xboxRefresh":"dpapi:!!"}}"#).unwrap();
        assert_eq!(old.accounts.steam_token, "plain");
        assert_eq!(old.accounts.xbox_refresh, "");
    }
}

/// Writes through a temp file so a crash mid-write never truncates the original.
fn write_json<T: Serialize>(path: &Path, value: &T) {
    let Ok(bytes) = serde_json::to_vec(value) else { return };
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, bytes).is_ok() {
        let _ = fs::rename(&tmp, path);
    }
}
