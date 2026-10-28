mod epic;
mod steam;
#[cfg(windows)]
mod windows_stores;

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::model::{Game, Launch};
use crate::store::{CustomGame, ResolvedArt, Settings, UserData};

pub use steam::cdn_art as steam_cdn_art;
pub use steam::current_user as steam_user;

#[derive(Default)]
pub struct Scan {
    pub games: Vec<Game>,
    /// Folders holding local art, to be opened to the asset protocol.
    pub asset_dirs: Vec<PathBuf>,
}

impl Scan {
    fn absorb(&mut self, other: Scan) {
        self.games.extend(other.games);
        self.asset_dirs.extend(other.asset_dirs);
    }
}

/// Scans every enabled store in parallel. Xbox goes through PowerShell and takes the longest.
pub fn scan_all(settings: &Settings, custom: &[CustomGame]) -> Scan {
    let s = &settings.sources;
    let mut out = Scan::default();
    std::thread::scope(|scope| {
        let mut jobs: Vec<(&str, std::thread::ScopedJoinHandle<Scan>)> = Vec::new();
        let timed = |name: &'static str, f: fn() -> Scan| {
            move || {
                let t = std::time::Instant::now();
                let scan = f();
                crate::log::info(&format!("scan {name}: {} games in {} ms", scan.games.len(), t.elapsed().as_millis()));
                scan
            }
        };
        if s.steam {
            jobs.push(("steam", scope.spawn(timed("steam", steam::scan))));
        }
        if s.epic {
            jobs.push(("epic", scope.spawn(timed("epic", epic::scan))));
        }
        #[cfg(windows)]
        {
            if s.gog {
                jobs.push(("gog", scope.spawn(timed("gog", windows_stores::scan_gog))));
            }
            if s.xbox {
                jobs.push(("xbox", scope.spawn(timed("xbox", windows_stores::scan_xbox))));
            }
            if s.ubisoft {
                jobs.push(("ubisoft", scope.spawn(timed("ubisoft", windows_stores::scan_ubisoft))));
            }
        }
        for (name, job) in jobs {
            match job.join() {
                Ok(scan) => out.absorb(scan),
                Err(_) => crate::log::warn(&format!("scan {name} panicked")),
            }
        }
    });
    out.games.extend(custom.iter().map(custom_game));
    for g in &mut out.games {
        resolve_paths(g);
    }
    out.asset_dirs = out.asset_dirs.iter().map(|d| PathBuf::from(real_path(&d.to_string_lossy()))).collect();

    out.games.sort_by_key(|g| sort_key(&g.name));
    let mut seen = std::collections::HashSet::new();
    out.games.retain(|g| seen.insert(g.id.clone()));
    out
}

pub fn custom_game(c: &CustomGame) -> Game {
    let path = Path::new(&c.path);
    let parent = path.parent().map(|p| p.to_string_lossy().to_string());
    let is_exe = path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe"));
    let launch = if is_exe {
        Launch::Exe { path: c.path.clone(), args: c.args.clone(), cwd: parent.clone() }
    } else {
        // Shortcuts, .url files, batch files: let the shell decide.
        Launch::Uri { uri: c.path.clone() }
    };
    let mut game = Game::new("custom", c.id.clone(), c.name.clone(), launch);
    let exe = if is_exe { Some(c.path.as_str()) } else { c.target.as_deref() };
    if let Some(exe) = exe {
        game.install_dir = Path::new(exe).parent().map(|p| p.to_string_lossy().to_string());
        game.exe_names.extend(crate::model::exe_name(exe));
    }
    game
}

/// Resolves junctions and symlinks to the path Windows reports for running processes.
/// Xbox installs live in `C:\XboxGames\…` behind a junction under `WindowsApps`.
pub fn real_path(p: &str) -> String {
    let Ok(c) = std::fs::canonicalize(p) else { return p.to_string() };
    let s = c.to_string_lossy().to_string();
    if let Some(unc) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{unc}")
    } else {
        s.strip_prefix(r"\\?\").map(String::from).unwrap_or(s)
    }
}

fn resolve_paths(g: &mut Game) {
    g.install_dir = g.install_dir.as_deref().map(real_path);
    for list in [&mut g.art.cover, &mut g.art.hero, &mut g.art.logo, &mut g.art.icon] {
        for src in list.iter_mut().filter(|s| !s.starts_with("http")) {
            *src = real_path(src);
        }
    }
}

pub fn sort_key(name: &str) -> String {
    let lower = name.to_lowercase();
    lower.strip_prefix("the ").map(String::from).unwrap_or(lower)
}

/// Layers the user's own data and online art over a raw scan.
pub fn apply_meta(games: &mut [Game], user: &UserData, art: &HashMap<String, ResolvedArt>) {
    for g in games.iter_mut() {
        if let Some(m) = user.meta.get(&g.id) {
            g.favorite = m.favorite;
            g.hidden = m.hidden;
            g.added_at = m.added_at;
            // Steam counts its own sessions, ours included; elsewhere only Mantel keeps time.
            g.playtime_minutes = g.playtime_minutes.max(m.tracked_minutes);
            g.last_played = g.last_played.max(m.last_played);
        }
        if let Some(resolved) = art.get(&g.id) {
            g.art = g.art.behind(&resolved.art);
            g.steam_app_id = g.steam_app_id.or(resolved.steam_app_id);
        }
    }
}

#[cfg(windows)]
pub mod reg {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    use winreg::RegKey;

    pub fn hklm(path: &str) -> Option<RegKey> {
        RegKey::predef(HKEY_LOCAL_MACHINE).open_subkey(path).ok()
    }

    pub fn hklm_str(path: &str, name: &str) -> Option<String> {
        hklm(path)?.get_value(name).ok()
    }

    pub fn hkcu_str(path: &str, name: &str) -> Option<String> {
        RegKey::predef(HKEY_CURRENT_USER).open_subkey(path).ok()?.get_value(name).ok()
    }
}
