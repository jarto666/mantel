mod epic;
pub mod steam;
#[cfg(windows)]
mod windows_stores;

use std::collections::HashMap;
use std::collections::HashSet;
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
    // A shortcut whose program couldn't be read when it was added, like one named with a ’, is
    // read again, so its game can be followed while it runs.
    out.games.extend(custom.iter().map(|c| match &c.target {
        None if c.path.to_lowercase().ends_with(".lnk") => custom_game(&CustomGame { target: crate::pick::shortcut_target(&c.path), ..c.clone() }),
        _ => custom_game(c),
    }));
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

/// Squares a scan with what the player added or took away by hand while it ran: the scan began
/// with the lists as they were then. `before` and `now` hold the ids of games and apps added by
/// hand at the start and at the end; one added meanwhile keeps the card it got from `cached`.
pub fn settle(games: &mut Vec<Game>, before: &HashSet<String>, now: &HashSet<String>, cached: &[Game]) {
    games.retain(|g| !before.contains(&g.id) || now.contains(&g.id));
    for id in now.difference(before) {
        if !games.iter().any(|g| &g.id == id) {
            games.extend(cached.iter().find(|g| &g.id == id).cloned());
        }
    }
    games.sort_by_key(|g| sort_key(&g.name));
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

/// Bytes in the files under `dir`, or None when it's unreadable or far too big a tree to be
/// one game. Links and junctions aren't followed.
pub fn dir_size(dir: &Path) -> Option<u64> {
    const MAX_ENTRIES: usize = 400_000;
    let mut total = 0;
    let mut entries = 0;
    let mut todo = vec![dir.to_path_buf()];
    while let Some(d) = todo.pop() {
        let Ok(list) = std::fs::read_dir(&d) else {
            if d == dir {
                return None;
            }
            continue;
        };
        for entry in list.flatten() {
            entries += 1;
            if entries > MAX_ENTRIES {
                return None;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                todo.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    Some(total)
}

/// The folder a custom game's files live in. Its exe often sits a few levels down, as in
/// Unreal's `<Game>\<Project>\Binaries\Win64`. None for drive roots and system folders.
pub fn game_root(exe_dir: &str) -> Option<PathBuf> {
    const BIN: &[&str] = &["win64", "win32", "x64", "x86", "bin", "binaries"];
    const SYSTEM: &[&str] = &["windows", "program files", "program files (x86)", "programdata", "users"];
    let mut dir = PathBuf::from(exe_dir);
    while dir.file_name().is_some_and(|n| BIN.contains(&n.to_string_lossy().to_lowercase().as_str())) {
        dir.pop();
    }
    if dir.parent().is_some_and(|up| up.join("Engine").is_dir()) {
        dir.pop();
    }
    let top_level = dir.components().count() <= 3;
    let system = dir.file_name().is_some_and(|n| SYSTEM.contains(&n.to_string_lossy().to_lowercase().as_str()));
    (!(top_level && system) && dir.components().count() >= 3).then_some(dir)
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
        if let Some(picked) = user.meta.get(&g.id).map(|m| &m.art).filter(|a| !a.is_empty()) {
            g.art = g.art.behind(picked);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn card(id: &str) -> Game {
        let (source, source_id) = id.split_once(':').unwrap();
        Game::new(source, source_id, id, Launch::Uri { uri: id.into() })
    }

    #[test]
    fn a_scan_keeps_what_was_added_by_hand_while_it_ran() {
        let ids = |list: &[&str]| list.iter().map(|s| s.to_string()).collect::<HashSet<String>>();
        // The scan began with one game added by hand. Meanwhile a second was added and an app
        // removed; the second game's card is in the cache already.
        let mut games = vec![card("steam:1"), card("custom:a"), card("app:x")];
        let before = ids(&["custom:a", "app:x"]);
        let now = ids(&["custom:a", "custom:b"]);
        let cached = vec![card("custom:a"), card("custom:b"), card("app:x")];
        settle(&mut games, &before, &now, &cached);
        let mut got: Vec<&str> = games.iter().map(|g| g.id.as_str()).collect();
        got.sort();
        assert_eq!(got, ["custom:a", "custom:b", "steam:1"]);
    }

    #[test]
    fn finds_game_roots() {
        let dir = std::env::temp_dir().join("mantel-root-test");
        std::fs::create_dir_all(dir.join("Engine")).unwrap();
        std::fs::create_dir_all(dir.join("Proj/Binaries/Win64")).unwrap();
        let exe_dir = dir.join("Proj/Binaries/Win64");
        assert_eq!(game_root(&exe_dir.to_string_lossy()), Some(dir.clone()));
        assert_eq!(dir_size(&dir), Some(0));
        std::fs::write(dir.join("Proj/data.pak"), [0u8; 10]).unwrap();
        assert_eq!(dir_size(&dir), Some(10));
        std::fs::remove_dir_all(&dir).unwrap();
        assert_eq!(game_root("/"), None);
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
