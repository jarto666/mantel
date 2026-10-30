mod accounts;
mod art;
mod fse;
mod launcher;
mod library;
mod log;
mod migrate;
mod model;
mod pick;
mod store;
mod system;
mod vdf;

use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use model::{now, Game};
use store::{AppState, CustomGame, MeasuredSize, Settings};

/// Unresolved art is retried after a week; the game may have reached Steam since.
const ART_RETRY_SECS: i64 = 7 * 24 * 3600;
/// Measured folder sizes are taken again after a week: games update.
const SIZE_RETRY_SECS: i64 = 7 * 24 * 3600;

fn snapshot(state: &AppState) -> Vec<Game> {
    let cache = state.cache.lock().unwrap();
    let user = state.user.lock().unwrap();
    let mut games = cache.library.clone();
    library::apply_meta(&mut games, &user, &cache.art);
    for g in games.iter_mut().filter(|g| g.size_bytes.is_none()) {
        g.size_bytes = g.install_dir.as_ref().and_then(|d| cache.sizes.get(d)).and_then(|s| s.bytes);
    }
    games
}

fn allow_assets(app: &AppHandle, dirs: &[std::path::PathBuf]) {
    let scope = app.asset_protocol_scope();
    for dir in dirs {
        let _ = scope.allow_directory(dir, true);
    }
}

fn rescan(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (settings, custom, steam_signed_in) = {
        let user = state.user.lock().unwrap();
        (user.settings.clone(), user.custom.clone(), user.accounts.steam_signed_in)
    };
    let mut scan = library::scan_all(&settings, &custom);
    allow_assets(app, &scan.asset_dirs);

    if settings.sources.steam && steam_signed_in {
        let owned = match tauri::async_runtime::block_on(accounts::steam_owned(app)) {
            Ok(mut list) => {
                log::info(&format!("steam account: {} owned games", list.len()));
                if let Err(e) = tauri::async_runtime::block_on(accounts::steam_achievements(app, &mut list)) {
                    log::warn(&e);
                }
                state.cache.lock().unwrap().owned_steam = list.clone();
                list
            }
            Err(e) => {
                log::warn(&format!("steam account: {e}; using last known list"));
                state.cache.lock().unwrap().owned_steam.clone()
            }
        };
        accounts::merge_steam(&mut scan.games, &owned);
        scan.games.sort_by_key(|g| library::sort_key(&g.name));
    }

    let xbox_signed_in = !state.user.lock().unwrap().accounts.xbox_refresh.is_empty();
    if settings.sources.xbox && xbox_signed_in {
        let titles = match tauri::async_runtime::block_on(accounts::xbox_titles(app)) {
            Ok(list) => {
                log::info(&format!("xbox account: {} PC games in history", list.len()));
                state.cache.lock().unwrap().owned_xbox = list.clone();
                list
            }
            Err(e) => {
                log::warn(&format!("xbox account: {e}; using last known list"));
                state.cache.lock().unwrap().owned_xbox.clone()
            }
        };
        accounts::merge_xbox(&mut scan.games, &titles);
        scan.games.sort_by_key(|g| library::sort_key(&g.name));
    }

    {
        let mut user = state.user.lock().unwrap();
        let t = now();
        for g in scan.games.iter().filter(|g| g.installed) {
            user.meta.entry(g.id.clone()).or_default().added_at.get_or_insert(t);
        }
        state.save_user(&user);
    }
    let mut cache = state.cache.lock().unwrap();
    cache.library = scan.games;
    cache.asset_dirs = scan.asset_dirs;
    state.save_cache(&cache);
}

/// Cached library instantly, or a fresh scan of every store when `rescan` is set.
#[tauri::command]
async fn get_library(app: AppHandle, rescan: bool) -> Result<Vec<Game>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let empty = state.cache.lock().unwrap().library.is_empty();
        if rescan || empty {
            self::rescan(&app);
        }
        snapshot(&state)
    })
    .await
    .map_err(|e| e.to_string())
}

/// Looks up art for games their store gave us none for. Returns whether anything changed.
#[tauri::command]
async fn resolve_art(state: State<'_, AppState>) -> Result<bool, String> {
    let (todo, key) = {
        let cache = state.cache.lock().unwrap();
        let user = state.user.lock().unwrap();
        let t = now();
        let todo: Vec<art::Lookup> = cache
            .library
            .iter()
            .filter(|g| g.source != "steam")
            .filter(|g| match cache.art.get(&g.id) {
                Some(r) => r.art.is_empty() && t - r.at > ART_RETRY_SECS,
                None => true,
            })
            .map(|g| art::Lookup { id: g.id.clone(), source: g.source.clone(), source_id: g.source_id.clone(), name: g.name.clone() })
            .collect();
        (todo, user.settings.steamgriddb_key.trim().to_string())
    };
    if todo.is_empty() {
        return Ok(false);
    }
    let found = art::resolve(todo, key).await;
    let mut cache = state.cache.lock().unwrap();
    cache.art.extend(found);
    state.save_cache(&cache);
    Ok(true)
}

/// Measures the install folders of games whose store reports no size: Xbox, GOG, Ubisoft and
/// games added by hand. Returns whether anything changed.
#[tauri::command]
async fn measure_sizes(state: State<'_, AppState>) -> Result<bool, String> {
    let todo: Vec<(String, std::path::PathBuf)> = {
        let cache = state.cache.lock().unwrap();
        let t = now();
        cache
            .library
            .iter()
            .filter(|g| g.installed && g.size_bytes.is_none())
            .filter_map(|g| {
                let dir = g.install_dir.clone()?;
                if cache.sizes.get(&dir).is_some_and(|s| t - s.at < SIZE_RETRY_SECS) {
                    return None;
                }
                let root = if g.source == "custom" { library::game_root(&dir)? } else { dir.clone().into() };
                Some((dir, root))
            })
            .collect()
    };
    if todo.is_empty() {
        return Ok(false);
    }
    let measured = tauri::async_runtime::spawn_blocking(move || {
        todo.into_iter().map(|(dir, root)| (dir, MeasuredSize { bytes: library::dir_size(&root), at: now() })).collect::<Vec<_>>()
    })
    .await
    .map_err(|e| e.to_string())?;
    let mut cache = state.cache.lock().unwrap();
    cache.sizes.extend(measured);
    state.save_cache(&cache);
    Ok(true)
}

#[tauri::command]
async fn get_details(state: State<'_, AppState>, id: String) -> Result<Option<Value>, String> {
    let appid = snapshot(&state).into_iter().find(|g| g.id == id).and_then(|g| g.steam_app_id);
    let Some(appid) = appid else { return Ok(None) };
    let cached = state.cache.lock().unwrap().details.get(&appid).cloned();
    // Details cached before trailers existed lack the key and are fetched again. Steam now and
    // then answers without the trailers, so a missing one is checked again once per run.
    static RECHECKED: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());
    let fresh = |d: &&Value| match d.get("trailer") {
        None => false,
        Some(Value::Null) => {
            let mut rechecked = RECHECKED.lock().unwrap();
            let seen = rechecked.contains(&appid);
            if !seen {
                rechecked.push(appid);
            }
            seen
        }
        Some(_) => true,
    };
    if let Some(hit) = cached.as_ref().filter(fresh) {
        return Ok(Some(hit.clone()));
    }
    let details = art::steam_details(appid).await;
    if let Some(d) = &details {
        let mut cache = state.cache.lock().unwrap();
        cache.details.insert(appid, d.clone());
        state.save_cache(&cache);
    }
    Ok(details.or(cached))
}

/// The game's achievements with the player's progress, from the store account it came from.
/// Xbox titles that report no total get it filled in from the list.
#[tauri::command]
async fn get_achievements(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<Vec<model::Achievement>, String> {
    let game = snapshot(&state).into_iter().find(|g| g.id == id).ok_or("Game not found")?;
    match game.source.as_str() {
        "steam" => accounts::steam_achievement_list(&app, game.source_id.parse().map_err(|_| "Unknown Steam app")?).await,
        "xbox" => {
            let title = state.cache.lock().unwrap().owned_xbox.iter().find(|t| t.pfn.eq_ignore_ascii_case(&game.source_id)).map(|t| t.title_id.clone());
            let title = title.filter(|t| !t.is_empty()).ok_or("Xbox Live has no achievements for this game")?;
            let list = accounts::xbox_achievement_list(&app, &title).await?;
            let mut cache = state.cache.lock().unwrap();
            let total = list.len() as u32;
            let fill = |a: &mut Option<model::Achievements>| {
                if let Some(a) = a.as_mut().filter(|a| a.total == 0) {
                    a.total = total;
                }
            };
            if let Some(t) = cache.owned_xbox.iter_mut().find(|t| t.title_id == title) {
                fill(&mut t.achievements);
            }
            if let Some(g) = cache.library.iter_mut().find(|g| g.id == id) {
                fill(&mut g.achievements);
            }
            state.save_cache(&cache);
            Ok(list)
        }
        _ => Err("Achievements come from Steam and Xbox accounts".into()),
    }
}

#[tauri::command]
fn set_flag(state: State<'_, AppState>, id: String, flag: String, value: bool) -> Result<(), String> {
    let mut user = state.user.lock().unwrap();
    let meta = user.meta.entry(id).or_default();
    match flag.as_str() {
        "favorite" => meta.favorite = value,
        "hidden" => meta.hidden = value,
        other => return Err(format!("unknown flag {other}")),
    }
    state.save_user(&user);
    Ok(())
}

#[tauri::command]
fn get_settings(state: State<'_, AppState>) -> Settings {
    state.user.lock().unwrap().settings.clone()
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, settings: Settings) {
    let mut user = state.user.lock().unwrap();
    user.settings = settings;
    state.save_user(&user);
}

/// Adds an exe, shortcut, .url or batch file. Shortcuts are launched as-is (keeping their
/// arguments) but tracked through the exe they point at; exes get their product name.
#[tauri::command]
async fn add_custom_game(app: AppHandle, path: String, name: Option<String>, target: Option<String>) -> Result<Vec<Game>, String> {
    let state = app.state::<AppState>();
    if state.user.lock().unwrap().custom.iter().any(|c| c.path.eq_ignore_ascii_case(&path)) {
        return Err("That one is already in your library".into());
    }
    let file = std::path::Path::new(&path);
    let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).ok_or("bad path")?;
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let (name, target) = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let target = target.or_else(|| (ext == "lnk").then(|| pick::shortcut_target(&path)).flatten());
            let name = name.or_else(|| (ext == "exe").then(|| pick::product_name(&path)).flatten()).unwrap_or(stem);
            (name, target)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    let custom = CustomGame { id: format!("{:x}", now()), name, path: path.clone(), args: Vec::new(), target };
    let game = library::custom_game(&custom);
    if let Some(dir) = game.install_dir.clone() {
        allow_assets(&app, &[dir.into()]);
    }
    log::info(&format!("custom game added: {} ({})", custom.name, custom.path));
    {
        let mut user = state.user.lock().unwrap();
        user.meta.entry(game.id.clone()).or_default().added_at = Some(now());
        user.custom.push(custom);
        state.save_user(&user);
    }
    {
        let mut cache = state.cache.lock().unwrap();
        cache.library.push(game);
        cache.library.sort_by_key(|g| library::sort_key(&g.name));
        state.save_cache(&cache);
    }
    Ok(snapshot(&state))
}

#[tauri::command]
fn rename_custom_game(state: State<'_, AppState>, id: String, name: String) -> Result<Vec<Game>, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("The name can't be empty".into());
    }
    {
        let mut user = state.user.lock().unwrap();
        let custom = user.custom.iter_mut().find(|c| format!("custom:{}", c.id) == id).ok_or("Only games you added can be renamed")?;
        custom.name = name.clone();
        state.save_user(&user);
    }
    {
        let mut cache = state.cache.lock().unwrap();
        if let Some(g) = cache.library.iter_mut().find(|g| g.id == id) {
            g.name = name;
        }
        // New name, new artwork lookup.
        cache.art.remove(&id);
        cache.library.sort_by_key(|g| library::sort_key(&g.name));
        state.save_cache(&cache);
    }
    Ok(snapshot(&state))
}

#[tauri::command]
async fn list_dir(path: Option<String>) -> Result<pick::Listing, String> {
    tauri::async_runtime::spawn_blocking(move || pick::list_dir(path.as_deref())).await.map_err(|e| e.to_string())?
}

/// Shortcuts on the desktop and in the Start menu that aren't in the library yet.
#[tauri::command]
async fn app_suggestions(state: State<'_, AppState>) -> Result<Vec<pick::Suggestion>, String> {
    let known: Vec<String> = {
        let cache = state.cache.lock().unwrap();
        let user = state.user.lock().unwrap();
        cache
            .library
            .iter()
            .filter_map(|g| g.install_dir.clone())
            .chain(user.custom.iter().map(|c| c.path.clone()))
            .collect()
    };
    tauri::async_runtime::spawn_blocking(move || pick::suggestions(&known)).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_custom_game(state: State<'_, AppState>, id: String) -> Vec<Game> {
    {
        let mut user = state.user.lock().unwrap();
        user.custom.retain(|c| format!("custom:{}", c.id) != id);
        state.save_user(&user);
    }
    {
        let mut cache = state.cache.lock().unwrap();
        cache.library.retain(|g| g.id != id);
        state.save_cache(&cache);
    }
    snapshot(&state)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SteamStatus {
    /// Account signed in to the Steam client on this machine.
    user: Option<String>,
    connected: bool,
    owned: usize,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountsStatus {
    steam: SteamStatus,
    xbox_gamertag: Option<String>,
}

fn accounts_snapshot(state: &AppState) -> AccountsStatus {
    let user = state.user.lock().unwrap();
    let owned = state.cache.lock().unwrap().owned_steam.len();
    AccountsStatus {
        steam: SteamStatus {
            user: library::steam_user().map(|(_, name)| name),
            connected: user.accounts.steam_signed_in,
            owned,
        },
        xbox_gamertag: Some(user.accounts.xbox_gamertag.clone()).filter(|g| !g.is_empty()),
    }
}

#[tauri::command]
fn accounts_status(state: State<'_, AppState>) -> AccountsStatus {
    accounts_snapshot(&state)
}

/// Steam's own sign-in page in a Mantel window; resolves once the account's games are in.
#[tauri::command]
async fn steam_sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<AccountsStatus, String> {
    accounts::steam_sign_in(&app).await?;
    let owned = accounts::steam_owned(&app).await?;
    {
        let mut cache = state.cache.lock().unwrap();
        cache.owned_steam = owned;
        state.save_cache(&cache);
    }
    Ok(accounts_snapshot(&state))
}

/// Microsoft's sign-in page in a Mantel window; resolves once signed in to Xbox Live.
#[tauri::command]
async fn xbox_sign_in(app: AppHandle, state: State<'_, AppState>) -> Result<AccountsStatus, String> {
    accounts::xbox_sign_in(&app).await?;
    Ok(accounts_snapshot(&state))
}

#[tauri::command]
async fn disconnect_account(app: AppHandle, state: State<'_, AppState>, service: String) -> Result<AccountsStatus, String> {
    match service.as_str() {
        "steam" => accounts::steam_sign_out(&app).await,
        "xbox" => {
            {
                let mut user = state.user.lock().unwrap();
                user.accounts.xbox_refresh.clear();
                user.accounts.xbox_gamertag.clear();
                user.accounts.xbox_session = Default::default();
                state.save_user(&user);
            }
            let mut cache = state.cache.lock().unwrap();
            cache.owned_xbox.clear();
            cache.library.retain(|g| g.installed || g.source != "xbox");
            state.save_cache(&cache);
        }
        _ => {}
    }
    if service == "steam" {
        let mut cache = state.cache.lock().unwrap();
        cache.owned_steam.clear();
        cache.library.retain(|g| g.installed || g.source != "steam");
        state.save_cache(&cache);
    }
    Ok(accounts_snapshot(&state))
}

/// Opens a web page in the default browser; only https, so the UI can't run programs.
#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only https links can be opened".into());
    }
    launcher::open_external(&url)
}

#[tauri::command]
fn launch_game(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    let game = state.cache.lock().unwrap().library.iter().find(|g| g.id == id).cloned();
    let game = game.ok_or("Game not found — refresh the library")?;
    launcher::launch(&app, &game)
}

#[tauri::command]
async fn switch_to_game(app: AppHandle) -> bool {
    tauri::async_runtime::spawn_blocking(move || launcher::switch_to(&app)).await.unwrap_or(false)
}

#[tauri::command]
fn close_game(app: AppHandle) {
    launcher::close(&app);
}

#[tauri::command]
fn running_game(state: State<'_, AppState>) -> Option<launcher::Running> {
    state.running.lock().unwrap().clone()
}

#[tauri::command]
fn open_game_folder(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let dir = state.cache.lock().unwrap().library.iter().find(|g| g.id == id).and_then(|g| g.install_dir.clone());
    launcher::open_folder(&dir.ok_or("Install folder unknown")?)
}

/// Lets the UI report what only it can see, such as artwork that failed to load.
#[tauri::command]
fn client_log(level: String, message: String) {
    log::write(&level.to_uppercase(), &format!("[ui] {message}"));
}

#[tauri::command]
fn power_status() -> system::Power {
    system::power()
}

#[tauri::command]
async fn quick_status() -> system::Quick {
    tauri::async_runtime::spawn_blocking(system::quick).await.unwrap_or_default()
}

#[tauri::command]
async fn set_volume(level: u8) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::set_volume(level)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_muted(muted: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::set_muted(muted)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
async fn set_brightness(level: u8) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || system::set_brightness(level)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn full_screen_mode() -> fse::Mode {
    fse::mode()
}

#[tauri::command]
fn power_action(app: AppHandle, action: String) -> Result<(), String> {
    system::action(&app, &action)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let moved = migrate::from_nova(&context.config().identifier);
    tauri::Builder::default()
        // Must come first: a second launch (e.g. from autostart) just refocuses us.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            log::init(&dir, &app.package_info().version.to_string());
            log::info(&format!("full screen experience: {}, package identity: {}", fse::active(), fse::packaged()));
            if moved.data {
                log::info(&format!("moved data from Nova (start with Windows: {})", moved.autostart));
            }
            if moved.autostart {
                use tauri_plugin_autostart::ManagerExt;
                let _ = app.autolaunch().enable();
            }
            let state = AppState::load(dir);
            let dirs = state.cache.lock().unwrap().asset_dirs.clone();
            let customs: Vec<_> = state.user.lock().unwrap().custom.iter().filter_map(|c| std::path::Path::new(&c.path).parent().map(|p| p.to_path_buf())).collect();
            app.manage(state);
            allow_assets(app.handle(), &dirs);
            allow_assets(app.handle(), &customs);
            launcher::spawn_tracker(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_library,
            resolve_art,
            measure_sizes,
            get_details,
            get_achievements,
            set_flag,
            get_settings,
            save_settings,
            add_custom_game,
            rename_custom_game,
            list_dir,
            app_suggestions,
            remove_custom_game,
            launch_game,
            close_game,
            switch_to_game,
            running_game,
            open_game_folder,
            power_status,
            power_action,
            quick_status,
            set_volume,
            set_muted,
            set_brightness,
            full_screen_mode,
            client_log,
            accounts_status,
            steam_sign_in,
            xbox_sign_in,
            disconnect_account,
            open_url,
        ])
        .run(context)
        .expect("error while running Mantel");
}
