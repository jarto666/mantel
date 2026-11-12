mod accounts;
mod apps;
mod art;
mod fse;
mod gamepass;
mod icons;
mod install;
mod steam_install;
mod steam_store;
mod xbox_store;
mod launcher;
mod library;
mod log;
mod migrate;
mod model;
mod pick;
mod store;
mod system;
mod uninstall;
mod update;
mod vdf;

pub use fse::{turn_on_developer_mode, DEVELOPER_MODE_ARG};
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
    for g in games.iter_mut() {
        cache.steam_facts.apply(g);
    }
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
    let (settings, custom, steam_signed_in, mut exclude) = {
        let user = state.user.lock().unwrap();
        let mut exclude = apps::Exclude { taken: user.apps.iter().map(|a| a.target.clone()).collect(), ..Default::default() };
        exclude.taken.extend(user.dismissed_apps.iter().cloned());
        (user.settings.clone(), user.custom.clone(), user.accounts.steam_signed_in, exclude)
    };
    // The Start menu is read while the stores scan: known apps join the Apps tab by themselves,
    // and Store apps on it follow their folder across updates.
    let icons = state.icons_dir();
    exclude.game_names.push("Mantel".into());
    let discovery = std::thread::spawn({
        let icons = icons.clone();
        move || {
            let list = apps::start_apps();
            let found = apps::discover_from(&list, &icons, &exclude, |a| apps::is_known(&a.name));
            (list, found)
        }
    });
    let mut scan = library::scan_all(&settings, &custom);
    let (list, found) = discovery.join().unwrap_or_default();
    let entries = {
        let mut user = state.user.lock().unwrap();
        let mut changed = apps::refresh(&list, &mut user.apps);
        // A known app that's also a game here (a launcher added by hand, say) stays a game.
        let games: Vec<String> = scan.games.iter().map(|g| g.name.to_lowercase()).collect();
        let found: Vec<apps::AppEntry> = found.into_iter().filter(|a| !games.contains(&a.name.to_lowercase())).collect();
        if !found.is_empty() {
            log::info(&format!("apps: {} found", found.len()));
            user.apps.extend(found);
            changed = true;
        }
        if changed {
            state.save_user(&user);
        }
        user.apps.clone()
    };
    let shown = apps::installed(&list, &entries);
    if shown.len() < entries.len() {
        log::info(&format!("apps: {} not installed any more", entries.len() - shown.len()));
    }
    let edge = apps::edge();
    scan.games.extend(shown.iter().map(|a| apps::game_of(a, edge.as_deref())));
    scan.asset_dirs.extend(shown.iter().filter_map(|a| a.location.as_ref().map(std::path::PathBuf::from)));
    scan.asset_dirs.push(icons);
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
            Ok(mut list) => {
                log::info(&format!("xbox account: {} PC games in history", list.len()));
                let installed: Vec<String> = scan.games.iter().filter(|g| g.source == "xbox").map(|g| g.source_id.clone()).collect();
                let known = state.cache.lock().unwrap().owned_xbox.clone();
                tauri::async_runtime::block_on(accounts::xbox_counts(app, &mut list, &known, &installed));
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
            // A game the scan hides by default stays hidden until the player says otherwise.
            user.meta.entry(g.id.clone()).or_insert_with(|| store::GameMeta { hidden: g.hidden, ..Default::default() }).added_at.get_or_insert(t);
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
            .filter(|g| g.source != "steam" && !g.is_app())
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

/// Asks Steam about the library's Steam games, and the other games that matched a Steam page:
/// genres, and art for those the plain addresses miss. Returns whether anything changed.
#[tauri::command]
async fn resolve_steam_facts(state: State<'_, AppState>, language: String) -> Result<bool, String> {
    let (todo, names_stale) = {
        let cache = state.cache.lock().unwrap();
        let steam = cache.library.iter().filter(|g| g.source == "steam").filter_map(|g| g.steam_app_id);
        let matched = cache.library.iter().filter_map(|g| cache.art.get(&g.id)?.steam_app_id);
        (cache.steam_facts.missing(steam.chain(matched)), cache.steam_facts.language != language)
    };
    if todo.is_empty() && !names_stale {
        return Ok(false);
    }
    let names = if names_stale { steam_store::genre_names(&language).await } else { None };
    let found = if todo.is_empty() { None } else { steam_store::facts(&todo, &language).await };
    let changed = names.is_some() || found.is_some();
    let mut cache = state.cache.lock().unwrap();
    if let Some(names) = names {
        cache.steam_facts.names = names;
        cache.steam_facts.language = language;
    }
    if let Some(found) = found {
        cache.steam_facts.apps.extend(found);
    }
    if changed {
        state.save_cache(&cache);
    }
    Ok(changed)
}

#[tauri::command]
async fn steam_store_home(language: String) -> Result<steam_store::Home, String> {
    steam_store::home(&language).await
}

#[tauri::command]
async fn steam_store_page(list: String, tag: Option<u32>, start: u32, language: String) -> Result<steam_store::Page, String> {
    steam_store::page(&list, tag, start, &language).await
}

#[tauri::command]
async fn xbox_store_home(language: String) -> Result<Vec<xbox_store::Shelf>, String> {
    xbox_store::home(&language).await
}

#[tauri::command]
async fn xbox_store_page(list: String, genre: Option<String>, page: u32, language: String) -> Result<xbox_store::Page, String> {
    xbox_store::page(&list, genre.as_deref(), page, &language).await
}

/// A game's page in the Xbox app, or the Microsoft Store without it.
#[tauri::command]
fn open_xbox_store(product: String) -> Result<(), String> {
    launcher::open_external(&format!("{}{}", gamepass::install_uri(), xbox_store::checked(&product)?))
}

/// A game's page in the Steam client, or on the web without one.
#[tauri::command]
fn open_steam_store(appid: u32) -> Result<(), String> {
    if library::steam_user().is_some() {
        return launcher::open_external(&format!("steam://store/{appid}"));
    }
    launcher::open_external(&format!("https://store.steampowered.com/app/{appid}"))
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
            .filter(|g| g.installed && g.size_bytes.is_none() && !g.is_app())
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

/// The PC Game Pass catalog in `language` (like "en-us"), looked up again once a day.
#[tauri::command]
async fn gamepass_catalog(state: State<'_, AppState>, language: String) -> Result<Vec<Game>, String> {
    let cached = {
        let cache = state.cache.lock().unwrap();
        let c = &cache.gamepass;
        (c.format == gamepass::FORMAT && c.language == language && now() - c.at < gamepass::FRESH_SECS).then(|| c.games.clone())
    };
    if let Some(games) = cached {
        return Ok(games);
    }
    match gamepass::fetch(&language).await {
        Ok(catalog) => {
            let games = catalog.games.clone();
            let mut cache = state.cache.lock().unwrap();
            cache.gamepass = catalog;
            state.save_cache(&cache);
            Ok(games)
        }
        Err(e) => {
            log::warn(&e);
            // Yesterday's catalog beats none.
            let stale = state.cache.lock().unwrap().gamepass.games.clone();
            if stale.is_empty() { Err(e) } else { Ok(stale) }
        }
    }
}

/// Installs a Game Pass game through Windows' Store installer; progress arrives as
/// "install-progress" events.
#[tauri::command]
fn install_game(app: AppHandle, state: State<'_, AppState>, id: String, chosen: Option<Vec<String>>) -> Result<(), String> {
    if id.starts_with(steam_install::ID_PREFIX) {
        return steam_install::start(&app, &id);
    }
    let product = store_product(&state, &id).ok_or("Only Store games install from Mantel")?;
    let targets = chosen.unwrap_or_else(|| vec![product.clone()]);
    // A catalog bundle's own packages; anywhere else, what was asked for.
    let packages = if id.starts_with(gamepass::ID_PREFIX) { gamepass::packages(&state.cache.lock().unwrap().gamepass, &product) } else { targets.clone() };
    install::start(&app, &id, &targets, &packages)
}

#[tauri::command]
async fn cancel_install(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if id.starts_with(steam_install::ID_PREFIX) {
        return steam_install::cancel(&id);
    }
    let product = store_product(&state, &id).ok_or("Not an install from Mantel")?;
    let packages = install::started(&id).unwrap_or_else(|| gamepass::packages(&state.cache.lock().unwrap().gamepass, &product));
    tauri::async_runtime::spawn_blocking(move || install::cancel(&packages)).await.map_err(|e| e.to_string())?
}

/// Installs under way, for a UI that just (re)loaded.
#[tauri::command]
fn installs() -> Vec<install::Progress> {
    install::active()
}

#[tauri::command]
async fn uninstall_game(app: AppHandle, state: State<'_, AppState>, id: String) -> Result<(), String> {
    if state.running.lock().unwrap().iter().any(|r| r.id == id) {
        return Err("Close the game first".into());
    }
    let game = state.cache.lock().unwrap().library.iter().find(|g| g.id == id && g.installed).cloned().ok_or("Game not found — refresh the library")?;
    tauri::async_runtime::spawn_blocking(move || uninstall::start(&app, &game)).await.map_err(|e| e.to_string())?
}

/// Whether a Store game is on the player's Microsoft account; nothing when the Store can't say.
#[tauri::command]
async fn install_access(state: State<'_, AppState>, id: String) -> Result<Option<bool>, String> {
    let Some(product) = store_product(&state, &id) else { return Ok(None) };
    tauri::async_runtime::spawn_blocking(move || install::on_account(&product)).await.map_err(|e| e.to_string())
}

/// A game's editions on sale, from any card of it. `id` is a store entry's, or a played game's.
#[tauri::command]
async fn xbox_editions(state: State<'_, AppState>, id: String, language: String) -> Result<Option<xbox_store::Editions>, String> {
    let Some(product) = store_product(&state, &id) else { return Ok(None) };
    Ok(xbox_store::editions(xbox_store::checked(&product)?, &language).await)
}

/// Whether an edition is on the account: its own licence, or every product inside it.
#[tauri::command]
async fn edition_on_account(id: String, parts: Vec<String>) -> Option<bool> {
    tauri::async_runtime::spawn_blocking(move || match install::on_account(&id) {
        Some(false) if !parts.is_empty() => parts.iter().try_fold(true, |all, part| Some(all && install::on_account(part)?)),
        answer => answer,
    })
    .await
    .ok()
    .flatten()
}

#[tauri::command]
async fn xbox_store_search(query: String, language: String) -> Result<Vec<xbox_store::SearchHit>, String> {
    xbox_store::search(&query, &language).await
}

#[tauri::command]
async fn steam_store_search(query: String, language: String) -> Result<Vec<Game>, String> {
    steam_store::search(&query, &language).await
}

#[tauri::command]
async fn installs_under_way(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    let busy = tauri::async_runtime::spawn_blocking(install::under_way).await.unwrap_or_default();
    let cache = state.cache.lock().unwrap();
    let played = cache.owned_xbox.iter().filter(|t| t.product_id.as_ref().is_some_and(|p| busy.contains(p))).map(|t| format!("xbox:{}", t.pfn));
    let listed = busy.iter().map(|product| format!("{}{product}", xbox_store::ID_PREFIX));
    Ok(cache
        .gamepass
        .games
        .iter()
        .filter_map(|g| g.id.strip_prefix(gamepass::ID_PREFIX))
        .filter(|product| gamepass::is_under_way(&cache.gamepass, product, &busy))
        .map(String::from)
        .chain(played)
        .chain(listed)
        .chain(steam_install::under_way())
        .collect())
}

/// The Store product behind a game: in the id of a catalog or store entry, and in the play history
/// for a played game. Other games don't install through Windows.
fn store_product(state: &AppState, id: &str) -> Option<String> {
    if let Some(product) = id.strip_prefix(gamepass::ID_PREFIX).or_else(|| id.strip_prefix(xbox_store::ID_PREFIX)) {
        return Some(product.to_string());
    }
    let pfn = id.strip_prefix("xbox:")?;
    state.cache.lock().unwrap().owned_xbox.iter().find(|t| t.pfn.eq_ignore_ascii_case(pfn))?.product_id.clone()
}

/// A library game, or one from the Game Pass catalog.
fn find_game(state: &AppState, id: &str) -> Option<Game> {
    let cache = state.cache.lock().unwrap();
    cache.library.iter().chain(&cache.gamepass.games).find(|g| g.id == id).cloned()
}

/// The game page's store details; `language` is Steam's name for it, like "french".
#[tauri::command]
async fn get_details(state: State<'_, AppState>, id: String, language: Option<String>) -> Result<Option<Value>, String> {
    let language = language.unwrap_or_else(|| "english".into());
    // An Xbox game keeps its Store page once installed, so its trailers and text don't change.
    // Steam's stands in below for what the Store has no page for.
    let id = match id.strip_prefix("xbox:") {
        Some(pfn) => gamepass::entry_for_package(&state.cache.lock().unwrap().gamepass, pfn).map_or_else(|| id.clone(), |g| g.id.clone()),
        None => id,
    };
    if id.starts_with("xbox:") {
        if let Some(product) = store_product(&state, &id).filter(|p| xbox_store::checked(p).is_ok()) {
            let catalog_language = state.cache.lock().unwrap().gamepass.language.clone();
            let key = state.user.lock().unwrap().settings.steamgriddb_key.trim().to_string();
            if let Some(page) = xbox_store::details(&product, if catalog_language.is_empty() { "en-us" } else { &catalog_language }, &key).await {
                return Ok(Some(page));
            }
        }
    }
    if let Some(product) = id.strip_prefix(xbox_store::ID_PREFIX) {
        let catalog_language = state.cache.lock().unwrap().gamepass.language.clone();
        let key = state.user.lock().unwrap().settings.steamgriddb_key.trim().to_string();
        return Ok(xbox_store::details(xbox_store::checked(product)?, if catalog_language.is_empty() { "en-us" } else { &catalog_language }, &key).await);
    }
    if id.starts_with(gamepass::ID_PREFIX) {
        let (details, name, hero) = {
            let cache = state.cache.lock().unwrap();
            let game = cache.gamepass.games.iter().find(|g| g.id == id);
            (cache.gamepass.details.get(&id).cloned(), game.map(|g| g.name.clone()).unwrap_or_default(), game.and_then(|g| g.art.hero.first().cloned()))
        };
        let Some(mut d) = details else { return Ok(None) };
        // The trailer and logo are looked up on first view, then kept with the catalog.
        if d.get("trailer").is_none() || d.get("logo").is_none() {
            let key = state.user.lock().unwrap().settings.steamgriddb_key.trim().to_string();
            let (trailer, logo) = futures::join!(gamepass::pick_trailer(&d, &name), art::find_logo(&name, &key));
            d["videos"] = gamepass::playable_videos(&d, trailer.as_deref(), hero.as_deref()).await.into();
            d["trailer"] = trailer.into();
            d["logo"] = logo.clone().into();
            let mut cache = state.cache.lock().unwrap();
            if let Some(game) = cache.gamepass.games.iter_mut().find(|g| g.id == id) {
                game.art.logo = logo;
            }
            cache.gamepass.details.insert(id, d.clone());
            state.save_cache(&cache);
        }
        return Ok(Some(d));
    }
    let appid = snapshot(&state).into_iter().find(|g| g.id == id).and_then(|g| g.steam_app_id);
    // A game off the store's lists isn't kept: browsing shouldn't grow the cache.
    let Some(appid) = appid else {
        let Some(appid) = id.strip_prefix(steam_install::ID_PREFIX).and_then(|n| n.parse().ok()) else { return Ok(None) };
        return Ok(art::steam_details(appid, &language).await);
    };
    let cached = state.cache.lock().unwrap().details.get(&appid).cloned();
    // Details cached before trailers existed lack the key and are fetched again. Steam now and
    // then answers without the trailers, so a missing one is checked again once per run.
    static RECHECKED: std::sync::Mutex<Vec<u32>> = std::sync::Mutex::new(Vec::new());
    let fresh = |d: &&Value| d.get("language").and_then(Value::as_str).unwrap_or("english") == language && d.get("videos").is_some() && match d.get("trailer") {
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
    let details = art::steam_details(appid, &language).await;
    if let Some(d) = &details {
        let mut cache = state.cache.lock().unwrap();
        cache.details.insert(appid, d.clone());
        state.save_cache(&cache);
    }
    Ok(details.or(cached))
}

/// The game's achievements with the player's progress, from the store account it came from.
/// Xbox titles that report no count get it from the list.
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
            let (unlocked, total) = (list.iter().filter(|a| a.unlocked).count() as u32, list.len() as u32);
            let fill = |a: &mut Option<model::Achievements>| {
                if let Some(a) = a.as_mut() {
                    a.count(unlocked, total);
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
    let new_key = state.user.lock().unwrap().settings.steamgriddb_key != settings.steamgriddb_key;
    if new_key {
        // Art found without SteamGridDB, or with another key, is looked up again.
        let mut cache = state.cache.lock().unwrap();
        cache.art.clear();
        for details in cache.gamepass.details.values_mut() {
            if let Some(details) = details.as_object_mut() {
                details.remove("logo");
            }
        }
        state.save_cache(&cache);
    }
    let mut user = state.user.lock().unwrap();
    user.settings = settings;
    state.save_user(&user);
}

/// Adds an exe, shortcut, .url or batch file. Resolved exe shortcuts launch the exe with the
/// shortcut's arguments and working folder; other file types are opened through the shell.
#[tauri::command]
async fn add_custom_game(app: AppHandle, path: String, name: Option<String>, target: Option<String>) -> Result<Vec<Game>, String> {
    let state = app.state::<AppState>();
    if state.user.lock().unwrap().custom.iter().any(|c| c.path.eq_ignore_ascii_case(&path)) {
        return Err("That one is already in your library".into());
    }
    let file = std::path::Path::new(&path);
    let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).ok_or("bad path")?;
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    let (name, target, args, working_dir, shortcut_launch) = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let shortcut = (ext == "lnk").then(|| pick::shortcut_info(&path)).flatten();
            let shortcut_launch = shortcut.as_ref().is_some_and(|s| s.target.to_lowercase().ends_with(".exe"));
            let target = shortcut
                .as_ref()
                .map(|s| s.target.trim().to_string())
                .filter(|t| !t.is_empty())
                .or(target);
            let args = if shortcut_launch {
                shortcut
                    .as_ref()
                    .map(|s| pick::parse_windows_args(&s.arguments))
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let working_dir = shortcut
                .as_ref()
                .map(|s| s.working_directory.trim().to_string())
                .filter(|dir| !dir.is_empty());
            let name = name
                .or_else(|| (ext == "exe").then(|| pick::product_name(&path)).flatten())
                .unwrap_or(stem);
            (name, target, args, working_dir, shortcut_launch)
        })
        .await
        .map_err(|e| e.to_string())?
    };
    let custom = CustomGame {
        id: format!("{:x}", now()),
        name,
        path: path.clone(),
        args,
        target,
        working_dir,
        shortcut_launch,
    };
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
async fn list_dir(path: Option<String>, images: Option<bool>) -> Result<pick::Listing, String> {
    tauri::async_runtime::spawn_blocking(move || pick::list_dir(path.as_deref(), images.unwrap_or(false))).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtChoices {
    /// The image picked before, if any.
    picked: Option<String>,
    options: Vec<art::Choice>,
    /// Whether a SteamGridDB key is set; without one there's nothing to choose from.
    connected: bool,
}

/// SteamGridDB's covers, backgrounds or logos for a game (`kind`), to pick one from.
#[tauri::command]
async fn art_choices(state: State<'_, AppState>, id: String, kind: String) -> Result<ArtChoices, String> {
    let game = snapshot(&state).into_iter().find(|g| g.id == id).ok_or("Game not found")?;
    let (key, picked) = {
        let user = state.user.lock().unwrap();
        let picked = user.meta.get(&id).and_then(|m| m.art.slot(&kind)).and_then(|s| s.first().cloned());
        (user.settings.steamgriddb_key.trim().to_string(), picked)
    };
    if key.is_empty() {
        return Ok(ArtChoices { picked, options: Vec::new(), connected: false });
    }
    let options = art::choices(&key, &kind, game.steam_app_id, &game.name).await?;
    Ok(ArtChoices { picked, options, connected: true })
}

/// Makes `src` the game's cover, background or logo: an https URL, or an image file, which is
/// copied so it survives the original moving. None goes back to the stores' art.
#[tauri::command]
fn set_art(state: State<'_, AppState>, id: String, kind: String, src: Option<String>) -> Result<Vec<Game>, String> {
    let dir = state.art_dir();
    let src = match src {
        Some(url) if url.starts_with("https://") => Some(url),
        Some(file) => Some(copy_art(&dir, &id, &kind, &file)?),
        None => None,
    };
    {
        let mut user = state.user.lock().unwrap();
        let slot = user.meta.entry(id).or_default().art.slot_mut(&kind).ok_or("Unknown kind of art")?;
        // A copy nothing points at any more is just clutter.
        for old in slot.drain(..).filter(|old| std::path::Path::new(old).starts_with(&dir)) {
            let _ = std::fs::remove_file(old);
        }
        slot.extend(src);
        state.save_user(&user);
    }
    Ok(snapshot(&state))
}

fn copy_art(dir: &std::path::Path, id: &str, kind: &str, file: &str) -> Result<String, String> {
    let from = std::path::Path::new(file);
    let ext = from.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !pick::IMAGES.contains(&ext.as_str()) {
        return Err("Pick a PNG, JPEG or WebP image".into());
    }
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    // A new name each time, so the WebView doesn't show a cached earlier pick.
    let safe: String = id.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    let to = dir.join(format!("{safe}-{kind}-{}.{ext}", now()));
    std::fs::copy(from, &to).map_err(|e| format!("Couldn't copy {file}: {e}"))?;
    Ok(to.to_string_lossy().to_string())
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

/// Marks an update as under way, right before the installer starts and closes Mantel.
#[tauri::command]
fn begin_update(state: State<'_, AppState>, version: String) {
    update::begin(state.dir(), &version);
    log::info(&format!("installing update {version}"));
}

/// The update failed before the installer ran: copies opened from now on start up as usual.
#[tauri::command]
fn end_update(state: State<'_, AppState>) {
    update::end(state.dir());
}

/// The version being installed while an update is under way: Xbox mode opens its home app again
/// as soon as the updater or the installer closes it, and that copy waits instead of starting up.
#[tauri::command]
async fn update_in_progress(app: AppHandle) -> Option<String> {
    let own = app.package_info().version.to_string();
    tauri::async_runtime::spawn_blocking(move || update::in_progress(app.state::<AppState>().dir(), &own)).await.ok().flatten()
}

/// Apps "Add an app" can offer: the Start menu's, games and apps on the tab left out, then
/// sites. Kept, so adding takes an app from this list and nothing else.
#[tauri::command]
async fn app_choices(app: AppHandle) -> Result<Vec<apps::AppEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        let exclude = {
            let user = state.user.lock().unwrap();
            let cache = state.cache.lock().unwrap();
            let games = cache.library.iter().filter(|g| !g.is_app());
            apps::Exclude {
                taken: user.apps.iter().map(|a| a.target.clone()).collect(),
                game_dirs: games.clone().filter_map(|g| g.install_dir.clone()).collect(),
                game_names: games.map(|g| g.name.clone()).collect(),
            }
        };
        let icons = state.icons_dir();
        let mut found = apps::discover(&icons, &exclude, |_| true);
        found.extend(
            apps::SITES
                .iter()
                .filter(|(_, url)| !exclude.taken.iter().any(|t| t == url))
                .map(|(name, url)| apps::AppEntry { name: name.to_string(), kind: "site".into(), target: url.to_string(), ..Default::default() }),
        );
        let mut dirs: Vec<std::path::PathBuf> = found.iter().filter_map(|a| a.location.as_ref().map(Into::into)).collect();
        dirs.push(icons);
        allow_assets(&app, &dirs);
        *state.app_choices.lock().unwrap() = found.clone();
        found
    })
    .await
    .map_err(|e| e.to_string())
}

/// Puts an app from the last "Add an app" list on the Apps tab. A site gets its icon from the
/// site itself.
#[tauri::command]
async fn add_app(app: AppHandle, target: String) -> Result<Vec<Game>, String> {
    let state = app.state::<AppState>();
    let mut entry = state.app_choices.lock().unwrap().iter().find(|c| c.target == target).cloned().ok_or("That app isn't on the list any more")?;
    if entry.kind == "site" && entry.icon.is_none() {
        entry.icon = apps::fetch_site_icon(&entry.target, &state.icons_dir(), &entry.id()).await;
    }
    let game = apps::game_of(&entry, apps::edge().as_deref());
    if let Some(location) = &entry.location {
        allow_assets(&app, &[location.into()]);
    }
    log::info(&format!("app added: {} ({})", entry.name, entry.kind));
    {
        let mut user = state.user.lock().unwrap();
        user.dismissed_apps.retain(|t| *t != entry.target);
        user.meta.entry(game.id.clone()).or_default().added_at = Some(now());
        if !user.apps.iter().any(|a| a.target == entry.target) {
            user.apps.push(entry);
        }
        state.save_user(&user);
    }
    {
        let mut cache = state.cache.lock().unwrap();
        cache.library.retain(|g| g.id != game.id);
        cache.library.push(game);
        state.save_cache(&cache);
    }
    Ok(snapshot(&state))
}

/// Puts a file the player picked on the Apps tab: an exe, a shortcut, a .url or a batch file.
/// Like a game added by hand, an exe gets its product name and a shortcut is followed through
/// the program it points at; the icon comes from that program.
#[tauri::command]
async fn add_app_file(app: AppHandle, path: String) -> Result<Vec<Game>, String> {
    let file = std::path::Path::new(&path);
    let ext = file.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !file.is_file() || !["exe", "lnk", "url", "bat", "cmd"].contains(&ext.as_str()) {
        return Err("Pick a program, a shortcut or a batch file".into());
    }
    let state = app.state::<AppState>();
    if state.user.lock().unwrap().apps.iter().any(|a| a.target.eq_ignore_ascii_case(&path)) {
        return Err("That one is already in your apps".into());
    }
    let stem = file.file_stem().map(|s| s.to_string_lossy().to_string()).ok_or("bad path")?;
    let icons = state.icons_dir();
    let mut entry = {
        let path = path.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let exe = if ext == "exe" { Some(path.clone()) } else if ext == "lnk" { pick::shortcut_target(&path).filter(|t| t.to_lowercase().ends_with(".exe")) } else { None };
            let name = exe.as_deref().filter(|_| ext == "exe").and_then(pick::product_name).unwrap_or(stem);
            let mut entry = apps::from_file(&path, name, exe);
            let out = icons.join(format!("{}.png", entry.id()));
            let source = entry.exe.clone().unwrap_or_else(|| path.clone());
            if icons::extract(&source, 0, &out) {
                entry.icon = Some(out.to_string_lossy().to_string());
            }
            entry
        })
        .await
        .map_err(|e| e.to_string())?
    };
    entry.name = entry.name.trim().to_string();
    let game = apps::game_of(&entry, None);
    log::info(&format!("app added from a file: {}", entry.name));
    {
        let mut user = state.user.lock().unwrap();
        user.meta.entry(game.id.clone()).or_default().added_at = Some(now());
        user.apps.push(entry);
        state.save_user(&user);
    }
    {
        let mut cache = state.cache.lock().unwrap();
        cache.library.retain(|g| g.id != game.id);
        cache.library.push(game);
        state.save_cache(&cache);
    }
    Ok(snapshot(&state))
}

/// Takes an app off the Apps tab for good: a known one doesn't come back by itself.
#[tauri::command]
fn remove_app(state: State<'_, AppState>, id: String) -> Vec<Game> {
    {
        let mut user = state.user.lock().unwrap();
        let gone: Vec<String> = user.apps.iter().filter(|a| format!("app:{}", a.id()) == id).map(|a| a.target.clone()).collect();
        user.apps.retain(|a| format!("app:{}", a.id()) != id);
        user.dismissed_apps.extend(gone);
        state.save_user(&user);
    }
    {
        let mut cache = state.cache.lock().unwrap();
        cache.library.retain(|g| g.id != id);
        state.save_cache(&cache);
    }
    snapshot(&state)
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

/// Pausing and resuming are Steam's to do.
#[tauri::command]
fn open_steam_downloads() -> Result<(), String> {
    launcher::open_external("steam://open/downloads")
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
    let game = find_game(&state, &id).ok_or("Game not found — refresh the library")?;
    launcher::launch(&app, &game)
}

#[tauri::command]
async fn switch_to_game(app: AppHandle, id: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || launcher::switch_to(&app, &id)).await.unwrap_or(false)
}

#[tauri::command]
async fn close_game(app: AppHandle, id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || launcher::close(&app, &id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn running_games(state: State<'_, AppState>) -> Vec<launcher::Running> {
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

/// Setup's and Settings' "Make Mantel the home app": Windows may ask the player for permission.
#[tauri::command]
async fn make_home_app(app: AppHandle) -> Result<fse::Mode, String> {
    let dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let version = app.package_info().version.to_string();
    // Windows shows its prompt over this window rather than behind it.
    #[cfg(windows)]
    let window = app.get_webview_window("main").and_then(|w| w.hwnd().ok()).map_or(0, |h| h.0 as isize);
    #[cfg(not(windows))]
    let window = 0;
    let made = tauri::async_runtime::spawn_blocking(move || fse::make_home(window, &dir, &version)).await.map_err(|e| e.to_string())?;
    // After Windows' prompt, yes or no, Mantel is where the player was.
    launcher::to_front(&app);
    made
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let context = tauri::generate_context!();
    let moved = migrate::from_nova(&context.config().identifier);
    tauri::Builder::default()
        // Must come first: a second launch (e.g. from autostart) just refocuses us.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| launcher::to_front(app)))
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
            let mut dirs = state.cache.lock().unwrap().asset_dirs.clone();
            dirs.push(state.art_dir());
            dirs.push(state.icons_dir());
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
            art_choices,
            set_art,
            gamepass_catalog,
            install_game,
            cancel_install,
            installs,
            installs_under_way,
            install_access,
            uninstall_game,
            app_suggestions,
            remove_custom_game,
            launch_game,
            close_game,
            switch_to_game,
            running_games,
            app_choices,
            begin_update,
            end_update,
            update_in_progress,
            add_app,
            add_app_file,
            remove_app,
            open_game_folder,
            power_status,
            power_action,
            quick_status,
            set_volume,
            set_muted,
            set_brightness,
            full_screen_mode,
            make_home_app,
            client_log,
            accounts_status,
            steam_sign_in,
            xbox_sign_in,
            disconnect_account,
            open_url,
            open_steam_downloads,
            open_steam_store,
            open_xbox_store,
            xbox_store_home,
            xbox_store_page,
            xbox_store_search,
            xbox_editions,
            edition_on_account,
            steam_store_search,
            resolve_steam_facts,
            steam_store_home,
            steam_store_page,
        ])
        .run(context)
        .expect("error while running Mantel");
}
