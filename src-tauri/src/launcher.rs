//! Starting games through their own launchers, and noticing any library game that runs,
//! whether Mantel started it or not, so playtime and "last played" stay honest. Several can
//! run at once: a game and a browser, or two games.

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
    launched(&mut app.state::<AppState>().running.lock().unwrap(), &game.id, now());
    Ok(())
}

/// A launch from Mantel. Only one waits for its process at a time, so an earlier launch that
/// never showed up is dropped; games already running stay.
fn launched(running: &mut Vec<Running>, id: &str, at: i64) {
    running.retain(|r| r.detected);
    if !running.iter().any(|r| r.id == id) {
        running.push(Running { id: id.to_string(), started_at: at, detected: false });
    }
}

/// A game's process appeared. A launch from Mantel keeps the time it was started.
fn detected(running: &mut Vec<Running>, id: &str, at: i64) {
    match running.iter_mut().find(|r| r.id == id) {
        Some(r) => r.detected = true,
        None => running.push(Running { id: id.to_string(), started_at: at, detected: true }),
    }
}

/// How long Mantel stays out of the way of a Gaming Services window after a game ends.
const SPLASH_WAIT: Duration = Duration::from_secs(600);

/// How long a game gets to quit by itself, saving as it goes, before it's terminated.
const CLOSE_GRACE: Duration = Duration::from_secs(5);

/// How long a terminated game may take to disappear: a big one takes a moment to let go of
/// its memory.
const KILL_WAIT: Duration = Duration::from_secs(3);

/// Filled by [`close`] once a game is gone, so its session ends without the usual grace.
static CLOSED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Closes a running game: asks its windows to close, as Alt+F4 would, then terminates
/// whatever is left. Anti-cheat can refuse the second step, and a game stuck inside Windows
/// can outlive it; that's when this returns an error.
pub fn close(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<AppState>();
    let Some(running) = state.running.lock().unwrap().iter().find(|r| r.id == id).cloned() else { return Ok(()) };
    let targets = targets(app);
    let target = targets.iter().find(|t| t.id == running.id);
    let name = state.cache.lock().unwrap().library.iter().find(|g| g.id == running.id).map(|g| g.name.clone()).unwrap_or_default();
    let mut sys = System::new();
    let alive = |sys: &mut System| {
        let mut pids = target.map(|t| processes_of(sys, t)).unwrap_or_default();
        pids.extend(splash_of(sys, &name));
        pids
    };
    let found = alive(&mut sys);
    if found.is_empty() {
        // Still starting (Steam updating, a login): nothing to close yet, so stop waiting for it.
        if !running.detected {
            let mut pending = PENDING.lock().unwrap();
            if pending.as_ref().is_some_and(|p| p.id == id) {
                *pending = None;
            }
            state.running.lock().unwrap().retain(|r| r.id != id);
        }
        return Ok(());
    }
    crate::log::info(&format!("close {}: {} processes", running.id, found.len()));
    ask_to_close(&found);
    let deadline = Instant::now() + CLOSE_GRACE;
    let mut left = found;
    while !left.is_empty() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(250));
        left = alive(&mut sys);
    }
    if !left.is_empty() {
        for &pid in &left {
            if let Err(e) = terminate(&sys, pid) {
                crate::log::warn(&format!("close {}: couldn't end process {pid}: {e}", running.id));
            }
        }
        let deadline = Instant::now() + KILL_WAIT;
        loop {
            std::thread::sleep(Duration::from_millis(250));
            left = alive(&mut sys);
            if left.is_empty() || Instant::now() >= deadline {
                break;
            }
        }
    }
    if !left.is_empty() {
        crate::log::warn(&format!("close {}: {} processes refused to quit", running.id, left.len()));
        let name = if name.is_empty() { "the game" } else { name.as_str() };
        return Err(format!("Windows didn't let Mantel close {name}. Quit it from the game's own menu."));
    }
    CLOSED.lock().unwrap().push(running.id);
    Ok(())
}

/// Brings a running game's window to the front. False when it has no window at all,
/// which happens when a game hangs or keeps running in the background after "closing".
pub fn switch_to(app: &AppHandle, id: &str) -> bool {
    if !app.state::<AppState>().running.lock().unwrap().iter().any(|r| r.id == id) {
        return false;
    }
    let targets = targets(app);
    let Some(target) = targets.iter().find(|t| t.id == id) else { return false };
    focus_window_of(&processes_of(&mut System::new(), target))
}

/// The splash Gaming Services shows while an Xbox game gets ready: a gamingservicesui window
/// titled with the game's name. It stays up when the game never starts, for instance when its
/// first-run setup is refused admin rights, and it lives outside the game's folder.
#[cfg(windows)]
fn splash_of(sys: &mut System, name: &str) -> Vec<u32> {
    let name = name.trim().to_lowercase();
    if name.is_empty() {
        return Vec::new();
    }
    refresh(sys);
    sys.processes()
        .iter()
        .filter(|(_, p)| p.name().to_string_lossy().eq_ignore_ascii_case("gamingservicesui.exe"))
        .map(|(pid, _)| pid.as_u32())
        .filter(|&pid| {
            main_windows(&[pid]).into_iter().any(|hwnd| window_title(hwnd).to_lowercase().starts_with(&name))
        })
        .collect()
}

#[cfg(windows)]
fn window_title(hwnd: windows_sys::Win32::Foundation::HWND) -> String {
    use windows_sys::Win32::UI::WindowsAndMessaging::GetWindowTextW;
    let mut buf = [0u16; 256];
    let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), buf.len() as i32) };
    String::from_utf16_lossy(&buf[..len.max(0) as usize]).trim().to_string()
}

/// Steam's windows besides its main one, like the dialog a steam:// link opens.
/// Steam titles its main window "Steam" in every language.
#[cfg(windows)]
pub fn steam_dialogs(sys: &mut System) -> Vec<isize> {
    refresh(sys);
    let pids: Vec<u32> = sys
        .processes()
        .iter()
        .filter(|(_, p)| p.name().to_string_lossy().eq_ignore_ascii_case("steamwebhelper.exe"))
        .map(|(pid, _)| pid.as_u32())
        .collect();
    main_windows(&pids).into_iter().filter(|w| { let title = window_title(*w); !title.is_empty() && title != "Steam" }).map(|w| w as isize).collect()
}

#[cfg(not(windows))]
pub fn steam_dialogs(_sys: &mut System) -> Vec<isize> {
    Vec::new()
}

#[cfg(not(windows))]
fn splash_of(_sys: &mut System, _name: &str) -> Vec<u32> {
    Vec::new()
}

/// The game's processes as of now, leaving out Mantel itself.
fn processes_of(sys: &mut System, target: &Target) -> Vec<u32> {
    refresh(sys);
    sys.processes()
        .iter()
        .filter(|(pid, p)| pid.as_u32() != std::process::id() && matches(target, p))
        .map(|(pid, _)| pid.as_u32())
        .collect()
}

/// Visible top-level windows of these processes, leaving out popups owned by another window.
#[cfg(windows)]
fn main_windows(pids: &[u32]) -> Vec<windows_sys::Win32::Foundation::HWND> {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindow, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER};

    struct Search<'a> {
        pids: &'a [u32],
        found: Vec<HWND>,
    }
    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> i32 {
        let search = &mut *(lparam as *mut Search);
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, &mut pid);
        if search.pids.contains(&pid) && IsWindowVisible(hwnd) != 0 && GetWindow(hwnd, GW_OWNER).is_null() {
            search.found.push(hwnd);
        }
        1
    }

    let mut search = Search { pids, found: Vec::new() };
    unsafe { EnumWindows(Some(visit), &mut search as *mut Search as LPARAM) };
    search.found
}

#[cfg(windows)]
fn focus_window_of(pids: &[u32]) -> bool {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IsIconic, SetForegroundWindow, ShowWindow, SW_RESTORE};
    let Some(&hwnd) = main_windows(pids).first() else { return false };
    unsafe {
        if IsIconic(hwnd) != 0 {
            ShowWindow(hwnd, SW_RESTORE);
        }
        SetForegroundWindow(hwnd) != 0
    }
}

/// What Alt+F4 sends. Games save and quit on it, or ask to confirm; it needs no rights over
/// the process, so it reaches games whose anti-cheat blocks terminating them. Windows keeps it
/// from the windows of a game running as administrator, which then gets terminated.
#[cfg(windows)]
fn ask_to_close(pids: &[u32]) {
    use windows_sys::Win32::Foundation::GetLastError;
    use windows_sys::Win32::UI::WindowsAndMessaging::{PostMessageW, WM_CLOSE};
    for hwnd in main_windows(pids) {
        if unsafe { PostMessageW(hwnd, WM_CLOSE, 0, 0) } == 0 {
            crate::log::info(&format!("close: a window didn't take the request (error {})", unsafe { GetLastError() }));
        }
    }
}

/// Ends a process, as Task Manager does. Not sysinfo's kill: that runs taskkill, which asks for
/// more than the right to terminate and so is refused for a game running as administrator,
/// while the right to terminate alone is granted for the player's own processes, elevated too.
#[cfg(windows)]
fn terminate(_sys: &System, pid: u32) -> Result<(), String> {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError};
    use windows_sys::Win32::System::Threading::{OpenProcess, TerminateProcess, PROCESS_TERMINATE};
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, pid);
        if process.is_null() {
            return Err(format!("no access (error {})", GetLastError()));
        }
        let ended = TerminateProcess(process, 1) != 0;
        let error = GetLastError();
        CloseHandle(process);
        if ended {
            Ok(())
        } else {
            Err(format!("error {error}"))
        }
    }
}

#[cfg(not(windows))]
fn terminate(sys: &System, pid: u32) -> Result<(), String> {
    match sys.process(sysinfo::Pid::from_u32(pid)) {
        Some(p) if p.kill() => Ok(()),
        Some(_) => Err("refused".into()),
        None => Ok(()),
    }
}

#[cfg(not(windows))]
fn focus_window_of(_pids: &[u32]) -> bool {
    false
}

#[cfg(not(windows))]
fn ask_to_close(_pids: &[u32]) {}

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
            let closed = std::mem::take(&mut *CLOSED.lock().unwrap());
            let mut ended = Vec::new();
            for (id, s) in sessions.iter_mut().filter(|(id, _)| !alive.contains(*id)) {
                s.misses += 1;
                if s.misses >= GRACE_POLLS || closed.contains(id) {
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
    detected(&mut state.running.lock().unwrap(), id, now());
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
    // The game was gone for every missed poll.
    let seconds = session.since.elapsed().as_secs().saturating_sub(POLL.as_secs() * session.misses as u64);
    // A game that didn't stay, like one refused its license at launch, hasn't been played.
    if seconds > 0 {
        let mut user = state.user.lock().unwrap();
        let meta = user.meta.entry(id.to_string()).or_default();
        meta.tracked_minutes += (seconds + 30) / 60;
        meta.last_played = Some(now());
        state.save_user(&user);
    }
    state.running.lock().unwrap().retain(|r| r.id != id);
    crate::log::info(&format!("session end {id} after {seconds}s"));
    let _ = app.emit("game-stopped", Stopped { id: id.to_string(), seconds });
    // Come back to the front only for games we sent the player into, and not over another
    // game the player has moved on to.
    if session.from_mantel {
        // Gaming Services may have something left to say, like that license refusal; Mantel
        // waits its turn instead of covering it.
        let name = state.cache.lock().unwrap().library.iter().find(|g| g.id == id).map(|g| g.name.clone()).unwrap_or_default();
        let app = app.clone();
        std::thread::spawn(move || {
            let (mut sys, start) = (System::new(), Instant::now());
            while start.elapsed() < SPLASH_WAIT && !splash_of(&mut sys, &name).is_empty() {
                std::thread::sleep(Duration::from_secs(1));
            }
            if !in_another_game(&app) {
                to_front(&app);
            }
        });
    }
}

/// Whether the window in front belongs to a game that's still running.
fn in_another_game(app: &AppHandle) -> bool {
    let ids: Vec<String> = app.state::<AppState>().running.lock().unwrap().iter().map(|r| r.id.clone()).collect();
    if ids.is_empty() {
        return false;
    }
    let mut sys = System::new();
    refresh(&mut sys);
    front_game(&sys, &targets(app)).is_some_and(|id| ids.contains(&id))
}

/// The library game whose window is in front, if any.
#[cfg(windows)]
fn front_game(sys: &System, targets: &[Target]) -> Option<String> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowThreadProcessId};
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(GetForegroundWindow(), &mut pid) };
    if pid == 0 || pid == std::process::id() {
        return None;
    }
    let process = sys.process(sysinfo::Pid::from_u32(pid))?;
    targets.iter().find(|t| matches(t, process)).map(|t| t.id.clone())
}

#[cfg(not(windows))]
fn front_game(_sys: &System, _targets: &[Target]) -> Option<String> {
    None
}

/// Puts Mantel back in front of whatever the player was sent to.
pub fn to_front(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
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
    app.state::<AppState>().running.lock().unwrap().retain(|r| r.id != id || r.detected);
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

#[cfg(test)]
mod tests {
    use super::*;

    fn ids(running: &[Running]) -> Vec<(&str, bool)> {
        running.iter().map(|r| (r.id.as_str(), r.detected)).collect()
    }

    #[test]
    fn a_second_game_runs_beside_the_first() {
        let mut running = Vec::new();
        launched(&mut running, "a", 100);
        detected(&mut running, "a", 130);
        launched(&mut running, "b", 200);
        detected(&mut running, "b", 210);
        assert_eq!(ids(&running), [("a", true), ("b", true)]);
        // A launch from Mantel counts from when it was started, not when its process showed up.
        assert_eq!(running.iter().map(|r| r.started_at).collect::<Vec<_>>(), [100, 200]);
    }

    #[test]
    fn a_new_launch_drops_one_that_never_started() {
        let mut running = Vec::new();
        detected(&mut running, "a", 100);
        launched(&mut running, "b", 200);
        launched(&mut running, "c", 300);
        assert_eq!(ids(&running), [("a", true), ("c", false)]);
        // Launching a game that's already running doesn't add it twice.
        launched(&mut running, "a", 400);
        assert_eq!(ids(&running), [("a", true)]);
    }

    #[test]
    fn a_game_started_outside_mantel_joins_the_list() {
        let mut running = Vec::new();
        launched(&mut running, "a", 100);
        detected(&mut running, "b", 150);
        assert_eq!(ids(&running), [("a", false), ("b", true)]);
    }

    #[test]
    fn terminates_a_process() {
        #[cfg(windows)]
        let mut child = std::process::Command::new("ping").args(["-n", "30", "127.0.0.1"]).stdout(std::process::Stdio::null()).spawn().unwrap();
        #[cfg(not(windows))]
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let mut sys = System::new();
        refresh(&mut sys);
        assert_eq!(terminate(&sys, child.id()), Ok(()));
        assert!(!child.wait().unwrap().success());
    }
}
