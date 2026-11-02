//! Steam downloads. Steam keeps the queue and asks the questions: Mantel opens its dialog, then
//! watches. The game's manifest says how much there is to do and when it's over, but Steam only
//! rewrites it between phases, so the bar follows what steam.exe writes to disk, which comes
//! within a fraction of a percent of BytesToStage.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Manager};

use crate::install::{self, Progress};
use crate::launcher;
use crate::library::steam::{self, Manifest};

pub const ID_PREFIX: &str = "steam:";

const TICK: Duration = Duration::from_secs(1);
/// How long Steam may take to start and put up anything at all.
const STEAM_START: Duration = Duration::from_secs(120);
/// How long its dialog may wait for an answer before Mantel stops waiting too.
const ANSWER: Duration = Duration::from_secs(600);
/// A yes shows up as a manifest soon after the dialog closes; past this it was a no.
const AFTER_DIALOG: Duration = Duration::from_secs(15);
/// Ticks without real movement before a started download counts as paused. steam.exe's own logs
/// keep the counter creeping, so movement means this many bytes on from the last time.
const QUIET: u32 = 15;
const MOVED: u64 = 1 << 20;

/// Downloads the player dropped before Steam's dialog got an answer.
static DROPPED: Mutex<Vec<u32>> = Mutex::new(Vec::new());

fn appid_of(id: &str) -> Result<u32, String> {
    id.strip_prefix(ID_PREFIX).and_then(|n| n.parse().ok()).ok_or_else(|| format!("Not a Steam game: {id}"))
}

/// steam.exe and what it has written since it started.
fn steam_writes(sys: &mut System) -> Option<(u32, u64)> {
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_disk_usage());
    sys.processes().values().find(|p| p.name().eq_ignore_ascii_case("steam.exe")).map(|p| (p.pid().as_u32(), p.disk_usage().total_written_bytes))
}

/// The counter reading that stands for nothing staged yet, kept on disk so that a restarted
/// Mantel picks the bar up where it was: the manifest may not have moved since the start.
fn mark_path(app: &AppHandle, appid: u32) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join(format!("steam-download-{appid}.txt")))
}

fn load_mark(path: Option<&Path>) -> Option<(u32, i64)> {
    let text = std::fs::read_to_string(path?).ok()?;
    let (pid, zero) = text.trim().split_once(' ')?;
    Some((pid.parse().ok()?, zero.parse().ok()?))
}

fn forget_mark(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = std::fs::remove_file(path);
    }
}

/// Where a tick leaves the download: the bytes staged by now, what to show for them.
fn progress(id: &str, m: &Manifest, to_stage: u64, to_download: u64, staged: u64, steam_up: bool, quiet: u32) -> Progress {
    let base = Progress { id: id.to_string(), state: "pending".into(), total: to_download, ..Default::default() };
    if !m.started() || to_stage == 0 {
        return base;
    }
    let part = (staged as f64 / to_stage as f64).min(1.0);
    let state = if part >= 1.0 {
        "installing"
    } else if !steam_up || quiet >= QUIET {
        "paused"
    } else {
        "downloading"
    };
    Progress { state: state.into(), percent: (part * 100.0) as f32, downloaded: (part * to_download as f64) as u64, ..base }
}

/// Waits out Steam's dialog, whose only trace is the manifest a yes creates. Steam may have to
/// start or sign in first, and `before` are dialogs left open from earlier, which aren't this
/// one. Says whether a dialog was up, or None if there's no download to follow.
fn answer(app: &AppHandle, sys: &mut System, id: &str, appid: u32, before: &[isize]) -> Option<(PathBuf, bool)> {
    let start = Instant::now();
    let (mut asked, mut closed) = (false, None);
    loop {
        if let Some(path) = steam::manifest_path(appid) {
            return Some((path, asked));
        }
        if DROPPED.lock().unwrap().contains(&appid) {
            break;
        }
        let dialogs = launcher::steam_dialogs(sys);
        if dialogs.iter().any(|d| !before.contains(d)) {
            (asked, closed) = (true, None);
            if start.elapsed() > ANSWER {
                break;
            }
        } else if asked {
            let at = *closed.get_or_insert_with(|| {
                launcher::to_front(app);
                Instant::now()
            });
            if at.elapsed() > AFTER_DIALOG {
                break;
            }
        } else if dialogs.is_empty() && start.elapsed() > STEAM_START {
            install::publish(app, Progress { id: id.to_string(), state: "error".into(), error: Some("Steam didn't open".into()), ..Default::default() });
            return None;
        } else if start.elapsed() > ANSWER {
            // Asking again only brings an old dialog back up, so it may be the one being answered.
            break;
        }
        std::thread::sleep(TICK);
    }
    DROPPED.lock().unwrap().retain(|a| *a != appid);
    install::publish(app, Progress { id: id.to_string(), state: "canceled".into(), ..Default::default() });
    None
}

fn follow(app: &AppHandle, id: &str, appid: u32, before: Vec<isize>) {
    let mut sys = System::new();
    let Some((manifest, mut dialog)) = answer(app, &mut sys, id, appid, &before) else { return };
    let mark = mark_path(app, appid);
    let mark = mark.as_deref();
    let mut zero = load_mark(mark);
    let mut saved = zero;
    let (mut to_stage, mut to_download, mut last, mut quiet) = (0, 0, 0, 0);
    crate::log::info(&format!("following steam install {appid}"));
    loop {
        // Whichever way a dialog of Steam's goes, its main window stays up in front of Mantel.
        let up = launcher::steam_dialogs(&mut sys).iter().any(|d| !before.contains(d));
        if dialog && !up {
            launcher::to_front(app);
        }
        dialog = up;

        if !manifest.exists() {
            forget_mark(mark);
            launcher::to_front(app);
            return install::publish(app, Progress { id: id.to_string(), state: "canceled".into(), ..Default::default() });
        }
        // None is Steam rewriting the file at this very moment.
        let Some(m) = steam::read_manifest(&manifest) else {
            std::thread::sleep(TICK);
            continue;
        };
        if m.installed() {
            forget_mark(mark);
            crate::log::info(&format!("steam install {appid} finished"));
            return install::publish(app, Progress { id: id.to_string(), state: "done".into(), percent: 100.0, downloaded: to_download, total: to_download, error: None });
        }
        // Steam blanks these for a moment when it resumes.
        if m.to_stage > 0 {
            (to_stage, to_download) = (m.to_stage, m.to_download);
        }
        let counter = steam_writes(&mut sys);
        if let Some((pid, written)) = counter {
            // Before Steam gets to this game its writes are another's, and a new steam.exe counts
            // from nothing again.
            if !m.started() || zero.is_none_or(|(p, _)| p != pid) {
                zero = Some((pid, written as i64 - m.staged as i64));
            }
        }
        if m.started() && zero != saved {
            if let (Some(path), Some((pid, at))) = (mark, zero) {
                let _ = std::fs::write(path, format!("{pid} {at}"));
            }
            saved = zero;
        }
        let measured = match (counter, zero) {
            (Some((_, written)), Some((_, at))) => (written as i64 - at).max(0) as u64,
            _ => 0,
        };
        let staged = measured.max(m.staged).min(to_stage);
        if staged >= last + MOVED {
            (last, quiet) = (staged, 0);
        } else {
            quiet += 1;
        }
        install::publish(app, progress(id, &m, to_stage, to_download, staged, counter.is_some(), quiet));
        std::thread::sleep(TICK);
    }
}

/// Opens Steam's install dialog, or picks up a download Steam already has, and follows it.
pub fn start(app: &AppHandle, id: &str) -> Result<(), String> {
    let appid = appid_of(id)?;
    if install::active().iter().any(|a| a.id == id) {
        return Ok(());
    }
    let before = launcher::steam_dialogs(&mut System::new());
    if steam::manifest_path(appid).is_none() {
        forget_mark(mark_path(app, appid).as_deref());
        DROPPED.lock().unwrap().retain(|a| *a != appid);
        launcher::open_external(&format!("steam://install/{appid}"))?;
    }
    install::publish(app, Progress { id: id.to_string(), state: "pending".into(), ..Default::default() });
    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || follow(&app, &id, appid, before));
    Ok(())
}

/// Steam has no link to cancel a download: uninstalling is how it drops one, after asking. The
/// manifest going away tells `follow`.
pub fn cancel(id: &str) -> Result<(), String> {
    let appid = appid_of(id)?;
    if steam::manifest_path(appid).is_none() {
        DROPPED.lock().unwrap().push(appid);
        return Ok(());
    }
    launcher::open_external(&format!("steam://uninstall/{appid}"))
}

/// Mantel's ids of what Steam is installing right now.
pub fn under_way() -> Vec<String> {
    steam::downloading().into_iter().map(|appid| format!("{ID_PREFIX}{appid}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const STARTED: Manifest = Manifest { flags: 1026, to_download: 400, to_stage: 800, staged: 0 };

    #[test]
    fn reads_app_ids() {
        assert_eq!(appid_of("steam:105600"), Ok(105600));
        assert!(appid_of("gamepass:9NBLGGH").is_err());
        assert!(appid_of("steam:1 & calc").is_err());
    }

    #[test]
    fn waits_until_steam_starts_on_it() {
        assert_eq!(progress("a", &Manifest { flags: 2, ..STARTED }, 800, 400, 0, true, 0).state, "pending");
        assert_eq!(progress("a", &STARTED, 0, 0, 0, true, 0).state, "pending");
    }

    #[test]
    fn scales_written_bytes_to_the_download() {
        let p = progress("a", &STARTED, 800, 400, 200, true, 0);
        assert_eq!((p.state.as_str(), p.percent, p.downloaded, p.total), ("downloading", 25.0, 100, 400));
    }

    #[test]
    fn installs_once_everything_is_written() {
        let p = progress("a", &STARTED, 800, 400, 800, false, 99);
        assert_eq!((p.state.as_str(), p.percent), ("installing", 100.0));
    }

    #[test]
    fn pauses_when_nothing_moves_or_steam_is_gone() {
        assert_eq!(progress("a", &STARTED, 800, 400, 200, true, QUIET).state, "paused");
        assert_eq!(progress("a", &STARTED, 800, 400, 200, false, 0).state, "paused");
    }
}
