use serde::{Deserialize, Serialize};

/// Image candidates, best first. Entries are `https://` URLs or absolute local paths;
/// the UI walks each list until one loads.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Art {
    pub cover: Vec<String>,
    pub hero: Vec<String>,
    pub logo: Vec<String>,
    pub icon: Vec<String>,
}

impl Art {
    pub fn is_empty(&self) -> bool {
        self.cover.is_empty() && self.hero.is_empty() && self.logo.is_empty() && self.icon.is_empty()
    }

    /// Appends `other`'s candidates after ours, skipping duplicates.
    pub fn extend(&mut self, other: &Art) {
        fn merge(into: &mut Vec<String>, from: &[String]) {
            for s in from {
                if !into.contains(s) {
                    into.push(s.clone());
                }
            }
        }
        merge(&mut self.cover, &other.cover);
        merge(&mut self.hero, &other.hero);
        merge(&mut self.logo, &other.logo);
        merge(&mut self.icon, &other.icon);
    }

    /// Returns `first` followed by our own candidates.
    pub fn behind(&self, first: &Art) -> Art {
        let mut out = first.clone();
        out.extend(self);
        out
    }
}

/// Achievement progress on the player's store account.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Achievements {
    pub unlocked: u32,
    /// 0 when the store doesn't say: Xbox leaves it out for many newer titles.
    pub total: u32,
    pub percent: u8,
    /// Xbox only.
    pub gamerscore: Option<u32>,
    pub gamerscore_total: Option<u32>,
}

impl Achievements {
    /// Takes a count learned elsewhere; the percentage then follows the count.
    pub fn count(&mut self, unlocked: u32, total: u32) {
        self.unlocked = unlocked;
        self.total = total;
        if total > 0 {
            self.percent = (100.0 * f64::from(unlocked) / f64::from(total)).round().min(100.0) as u8;
        }
    }
}

/// One achievement for the game page's list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Achievement {
    pub name: String,
    pub description: String,
    pub icon: Option<String>,
    pub unlocked: bool,
    pub unlocked_at: Option<i64>,
    /// Share of players who have it, in percent.
    pub rarity: Option<f32>,
    pub gamerscore: Option<u32>,
    /// Locked and meant to stay a surprise.
    pub secret: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Launch {
    /// Protocol or shell URI handed to the OS (`steam://…`, `shell:AppsFolder\…`).
    Uri { uri: String },
    Exe {
        path: String,
        #[serde(default)]
        args: Vec<String>,
        cwd: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Game {
    pub id: String,
    pub source: String,
    pub source_id: String,
    pub name: String,
    pub install_dir: Option<String>,
    pub launch: Launch,
    #[serde(default)]
    pub art: Art,
    /// Executable file names that identify the game's process when its folder can't.
    #[serde(default)]
    pub exe_names: Vec<String>,
    /// Steam app id for store metadata: the game's own on Steam, a name match elsewhere.
    pub steam_app_id: Option<u32>,
    #[serde(default)]
    pub playtime_minutes: u64,
    pub last_played: Option<i64>,
    pub added_at: Option<i64>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub hidden: bool,
    pub size_bytes: Option<u64>,
    /// False for games an account owns but this machine doesn't have; launching installs.
    #[serde(default = "installed_default")]
    pub installed: bool,
    #[serde(default)]
    pub achievements: Option<Achievements>,
}

fn installed_default() -> bool {
    true
}

impl Game {
    pub fn new(source: &str, source_id: impl Into<String>, name: impl Into<String>, launch: Launch) -> Self {
        let source_id = source_id.into();
        Game {
            id: format!("{source}:{source_id}"),
            source: source.into(),
            source_id,
            name: name.into(),
            install_dir: None,
            launch,
            art: Art::default(),
            exe_names: Vec::new(),
            steam_app_id: None,
            playtime_minutes: 0,
            last_played: None,
            added_at: None,
            favorite: false,
            hidden: false,
            size_bytes: None,
            installed: true,
            achievements: None,
        }
    }
}

/// Executable names too generic to identify one game by name alone.
/// Anti-cheat bootstrappers and store helpers ship under the same name in many games.
const GENERIC_EXES: &[&str] = &[
    "game.exe", "launcher.exe", "start.exe", "play.exe", "client.exe", "setup.exe", "run.exe", "main.exe",
    "start_protected_game.exe", "gamelaunchhelper.exe", "easyanticheat_launcher.exe", "crashpad_handler.exe",
    "unitycrashhandler64.exe", "unitycrashhandler32.exe",
];

/// File name of `path` if it can stand in for the game's identity.
pub fn exe_name(path: &str) -> Option<String> {
    let name = path.rsplit(['\\', '/']).next()?.to_lowercase();
    (name.ends_with(".exe") && !GENERIC_EXES.contains(&name.as_str())).then_some(name)
}

pub fn now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
