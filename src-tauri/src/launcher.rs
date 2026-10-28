//! Starting games through their own launchers, and noticing any library game that runs,
//! whether Mantel started it or not, so playtime and "last played" stay honest.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter, Manager};

use crate::model::{now, Game, Launch};
use crate::store::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Running {
    pub id: String,
    pub started_at: i64,
    /// False while a launch from Mantel is still waiting for the game's process.
    pub detected: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Stopped {
    id: String,
    seconds: u64,
}

/// A launch from Mantel whose process hasn't shown up yet.
struct Pending {
    id: String,
    at: Instant,
    pid: Option<u32>,
    trackable: bool,
}

struct Session {
    since: Instant,
    misses: u32,
    from_mantel: bool,
}

/// What identifies a game's processes: its install folder, or known executable names.
struct Target {
    id: String,
    dir: Option<String>,
    exes: Vec<String>,
}

static PENDING: Mutex<Option<Pending>> = Mutex::new(None);

/// Launchers like Steam may update or show a login before the game appears.
const DETECT_WINDOW: Duration = Duration::from_secs(150);
const POLL: Duration = Duration::from_secs(3);
/// Polls a game may be missing before its session ends; covers games that restart
/// themselves through anti-cheat or a launcher stub.
const GRACE_POLLS: u32 = 3;

pub fn launch(app: &AppHandle, game: &Game) -> Result<(), String> {
    if !game.installed {
        // Owned elsewhere: hand over to the store's install dialog, nothing to track yet.
        crate::log::info(&format!("install {} via {:?}", game.id, game.launch));
        return match &game.launch {
            Launch::Uri { uri } => open_uri(uri),
            Launch::Exe { .. } => Err("This game isn't installed".into()),
        };
    }
    let pid = match &game.launch {
        Launch::Uri { uri } => {
            open_uri(uri)?;
            None
        }
        Launch::Exe { path, args, cwd } => {
            let mut cmd = std::process::Command::new(path);
            cmd.args(args);
            if let Some(dir) = cwd.as_deref().or_else(|| Path::new(path).parent().and_then(Path::to_str)) {
                cmd.current_dir(dir);
            }
            Some(cmd.spawn().map_err(|e| format!("Couldn't start {path}: {e}"))?.id())
        }
    };
    crate::log::info(&format!("launch {} via {:?}", game.id, game.launch));

    let trackable = pid.is_some() || game.install_dir.is_some() || !game.exe_names.is_empty();
    *PENDING.lock().unwrap() = Some(Pending { id: game.id.clone(), at: Instant::now(), pid, trackable });
    *app.state::<AppState>().running.lock().unwrap() = Some(Running { id: game.id.clone(), started_at: now(), detected: false });
    Ok(())
}

/// Kills every process that belongs to the running game.
pub fn close(app: &AppHandle) {
    let Some(id) = app.state::<AppState>().running.lock().unwrap().as_ref().map(|r| r.id.clone()) else { return };
    let targets = targets(app);
    let Some(target) = targets.iter().find(|t| t.id == id) else { return };
    let mut sys = System::new();
    refresh(&mut sys);
    for (pid, p) in sys.processes() {
        if pid.as_u32() != std::process::id() && matches(target, p) {
            p.kill();
        }
    }
}

/// Brings the running game's window to the front. False when it has no window at all,
/// which happens when a game hangs or keeps running in the background after "closing".
pub fn switch_to(app: &AppHandle) -> bool {
    let Some(id) = app.state::<AppState>().running.lock().unwrap().as_ref().map(|r| r.id.clone()) else { return false };
    let targets = targets(app);
    let Some(target) = targets.iter().find(|t| t.id == id) else { return false };
    let mut sys = System::new();
    refresh(&mut sys);
    let pids: Vec<u32> = sys
        .processes()
        .iter()
        .filter(|(pid, p)| pid.as_u32() != std::process::id() && matches(target, p))
        .map(|(pid, _)| pid.as_u32())
        .collect();
    focus_window_of(&pids)
}

#[cfg(windows)]
fn focus_window_of(pids: &[u32]) -> bool {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetWindow, GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow, ShowWindow, GW_OWNER, SW_RESTORE,
    };

    struct Search<'a> {
        pids: &'a [u32],
        found: HWND,
    }
    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> i32 {
        let search = &mut *(lparam as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        // A visible top-level window that isn't a tool popup of something else.
        if search.pids.contains(&pid) && IsWindowVisible(hwnd) != 0 && GetWindow(hwnd, GW_OWNER).is_null() {
            search.found = hwnd;
            return 0;
        }
        1
    }

    let mut search = Search { pids, found: std::ptr::null_mut() };
    unsafe {
        EnumWindows(Some(visit), &mut search as *mut Search as LPARAM);
        if search.found.is_null() {
            return false;
        }
        if IsIconic(search.found) != 0 {
            ShowWindow(search.found, SW_RESTORE);
        }
        SetForegroundWindow(search.found) != 0
    }
}

#[cfg(not(windows))]
fn focus_window_of(_pids: &[u32]) -> bool {
    false
}

/// One background thread watches every library game for the life of the app.
pub fn spawn_tracker(app: AppHandle) {
    std::thread::spawn(move || {
        let mut sys = System::new();
        let mut sessions: HashMap<String, Session> = HashMap::new();
        loop {
            std::thread::sleep(POLL);
            let targets = targets(&app);
            refresh(&mut sys);

            let pending_pid = PENDING.lock().unwrap().as_ref().and_then(|p| Some((p.id.clone(), p.pid?)));
            let mut alive: HashSet<String> = HashSet::new();
            for (pid, p) in sys.processes() {
                let pid = pid.as_u32();
                if pid == std::process::id() {
                    continue;
                }
                if let Some((id, _)) = pending_pid.as_ref().filter(|(_, ppid)| *ppid == pid) {
                    alive.insert(id.clone());
                } else if let Some(t) = targets.iter().find(|t| matches(t, p)) {
                    alive.insert(t.id.clone());
                }
            }

            for id in &alive {
                match sessions.get_mut(id) {
                    Some(s) => s.misses = 0,
                    None => {
                        let from_mantel = started(&app, id);
                        sessions.insert(id.clone(), Session { since: Instant::now(), misses: 0, from_mantel });
                    }
                }
            }
            let mut ended = Vec::new();
            for (id, s) in sessions.iter_mut().filter(|(id, _)| !alive.contains(*id)) {
                s.misses += 1;
                if s.misses >= GRACE_POLLS {
                    ended.push(id.clone());
                }
            }
            for id in ended {
                if let Some(s) = sessions.remove(&id) {
                    finish(&app, &id, &s);
                }
            }
            expire_pending(&app, &sessions);
        }
    });
}

/// A game's process just appeared. Returns whether Mantel launched it.
fn started(app: &AppHandle, id: &str) -> bool {
    let state = app.state::<AppState>();
    let from_mantel = {
        let mut pending = PENDING.lock().unwrap();
        let hit = pending.as_ref().is_some_and(|p| p.id == id);
        if hit {
            *pending = None;
        }
        hit
    };
    {
        let mut running = state.running.lock().unwrap();
        let keep_start = running.as_ref().filter(|r| r.id == id).map(|r| r.started_at);
        if running.as_ref().is_none_or(|r| r.id == id || !r.detected) {
            *running = Some(Running { id: id.to_string(), started_at: keep_start.unwrap_or_else(now), detected: true });
        }
    }
    crate::log::info(&format!("session start {id} (from mantel: {from_mantel})"));
    let _ = app.emit("game-started", id);
    if from_mantel && state.user.lock().unwrap().settings.minimize_on_launch {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.minimize();
        }
    }
    from_mantel
}

fn finish(app: &AppHandle, id: &str, session: &Session) {
    let state = app.state::<AppState>();
    let seconds = session.since.elapsed().as_secs().saturating_sub(POLL.as_secs() * GRACE_POLLS as u64);
    {
        let mut user = state.user.lock().unwrap();
        let meta = user.meta.entry(id.to_string()).or_default();
        meta.tracked_minutes += (seconds + 30) / 60;
        meta.last_played = Some(now());
        state.save_user(&user);
    }
    {
        let mut running = state.running.lock().unwrap();
        if running.as_ref().is_some_and(|r| r.id == id) {
            *running = None;
        }
    }
    crate::log::info(&format!("session end {id} after {seconds}s"));
    let _ = app.emit("game-stopped", Stopped { id: id.to_string(), seconds });
    // Come back to the front only for games we sent the player into.
    if session.from_mantel {
        if let Some(w) = app.get_webview_window("main") {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
}

fn expire_pending(app: &AppHandle, sessions: &HashMap<String, Session>) {
    let mut pending = PENDING.lock().unwrap();
    let Some(p) = pending.as_ref() else { return };
    let limit = if p.trackable { DETECT_WINDOW } else { Duration::from_secs(8) };
    if sessions.contains_key(&p.id) || p.at.elapsed() < limit {
        return;
    }
    let id = p.id.clone();
    *pending = None;
    let state = app.state::<AppState>();
    let mut running = state.running.lock().unwrap();
    if running.as_ref().is_some_and(|r| r.id == id && !r.detected) {
        *running = None;
    }
    crate::log::warn(&format!("launch {id}: no process seen within {}s", limit.as_secs()));
    let _ = app.emit("game-launch-timeout", &id);
}

fn targets(app: &AppHandle) -> Vec<Target> {
    let state = app.state::<AppState>();
    let cache = state.cache.lock().unwrap();
    cache
        .library
        .iter()
        .filter(|g| g.install_dir.is_some() || !g.exe_names.is_empty())
        .map(|g| Target {
            id: g.id.clone(),
            dir: g.install_dir.as_deref().map(normalize_dir),
            exes: g.exe_names.iter().map(|e| e.to_lowercase()).collect(),
        })
        .collect()
}

fn refresh(sys: &mut System) {
    // Exe paths are cached per pid, so after the first pass only new processes cost anything.
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet));
}

fn matches(t: &Target, p: &sysinfo::Process) -> bool {
    if let (Some(dir), Some(exe)) = (&t.dir, p.exe()) {
        if normalize_path(&exe.to_string_lossy()).starts_with(dir.as_str()) {
            return true;
        }
    }
    !t.exes.is_empty() && t.exes.contains(&p.name().to_string_lossy().to_lowercase())
}

fn normalize_path(p: &str) -> String {
    p.replace('/', "\\").to_lowercase()
}

/// Lowercase with a trailing separator, so `C:\Games\Foo` doesn't match `C:\Games\FooBar`.
fn normalize_dir(p: &str) -> String {
    let mut s = normalize_path(p);
    if !s.ends_with('\\') {
        s.push('\\');
    }
    s
}

pub fn open_external(uri: &str) -> Result<(), String> {
    open_uri(uri)
}

pub fn open_folder(path: &str) -> Result<(), String> {
    #[cfg(windows)]
    let cmd = "explorer.exe";
    #[cfg(not(windows))]
    let cmd = "open";
    std::process::Command::new(cmd).arg(PathBuf::from(path)).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// ShellExecute on its own COM-initialised thread: shell: URIs and protocol handlers need COM.
#[cfg(windows)]
fn open_uri(uri: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (verb, file) = (wide("open"), wide(uri));
    let code = std::thread::spawn(move || unsafe {
        CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32);
        let r = ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), std::ptr::null(), std::ptr::null(), SW_SHOWNORMAL);
        CoUninitialize();
        r as isize
    })
    .join()
    .map_err(|_| "ShellExecute panicked".to_string())?;
    // Values above 32 mean success.
    if code > 32 {
        Ok(())
    } else {
        Err(format!("Windows couldn't open {uri} (code {code})"))
    }
}

#[cfg(not(windows))]
fn open_uri(uri: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(not(target_os = "macos"))]
    let cmd = "xdg-open";
    std::process::Command::new(cmd).arg(uri).spawn().map(|_| ()).map_err(|e| e.to_string())
}
