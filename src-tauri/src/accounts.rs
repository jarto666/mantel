//! Optional store accounts: what never reaches the disk, like games owned but not
//! installed and playtime from other devices.
//!
//! Steam: the player signs in on Steam's own page in a Mantel window (email Steam Guard
//! works, no API key, no mobile authenticator). The session lives in the WebView's own
//! cookie jar. When Mantel needs data, a store page asks Steam for the short-lived Web API
//! token the store itself uses and hands it over by navigating to a bridge URL that Mantel
//! intercepts. Reading cookies directly is avoided on purpose: on Windows it runs a
//! nested message loop on the UI thread, which froze the sign-in window.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tokio::sync::mpsc;

use crate::library::steam_cdn_art;
use crate::model::{now, Game, Launch};
use crate::store::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedSteam {
    pub appid: u32,
    pub name: String,
    pub minutes: u64,
    pub last_played: i64,
}

const STORE: &str = "https://store.steampowered.com";
const LOGIN_WINDOW: &str = "steam-login";
const RENEW_WINDOW: &str = "steam-renew";
const BRIDGE_HOST: &str = "mantel.invalid";
/// Runs on a signed-in store page: fetch the store's own Web API token, pass it to Mantel.
const GRAB_TOKEN: &str = "fetch('/pointssummary/ajaxgetasyncconfig',{credentials:'include'})\
    .then(r=>r.text()).catch(()=>'')\
    .then(t=>location.replace('https://mantel.invalid/steam#'+encodeURIComponent(t)))";

enum Outcome {
    Token(String),
    SignedOut,
    Closed,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Mantel/0.1 (game launcher)")
        .build()
        .unwrap_or_default()
}

/// The Web API token is a JWT: its subject is the SteamID64, plus an expiry.
fn parse_token(jwt: &str) -> Option<(u64, i64)> {
    let payload = jwt.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: Value = serde_json::from_slice(&bytes).ok()?;
    Some((claims.get("sub")?.as_str()?.parse().ok()?, claims.get("exp")?.as_i64()?))
}

/// A window on the Steam store that reports back through `tx` once it knows the outcome.
fn steam_window(app: &AppHandle, label: &str, url: &str, visible: bool, tx: mpsc::UnboundedSender<Outcome>) -> Result<WebviewWindow, String> {
    let url = Url::parse(url).map_err(|e| e.to_string())?;
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::External(url));
    // Same WebView2 options as the main window: environments with different flags can't coexist.
    if let Some(args) = app.config().app.windows.first().and_then(|w| w.additional_browser_args.clone()) {
        builder = builder.additional_browser_args(&args);
    }
    let tx_load = tx.clone();
    let tx_nav = tx.clone();
    let w = builder
        .title("Sign in to Steam")
        .inner_size(980.0, 760.0)
        .center()
        .always_on_top(true)
        .visible(visible)
        .on_page_load(move |w, p| {
            if p.event() != PageLoadEvent::Finished || p.url().host_str() != Some("store.steampowered.com") {
                return;
            }
            let path = p.url().path();
            if path.starts_with("/account") {
                let _ = w.eval(GRAB_TOKEN);
            } else if path.starts_with("/login") && !visible {
                // A background renewal landed on the sign-in wall: the session is gone.
                let _ = tx_load.send(Outcome::SignedOut);
            }
        })
        .on_navigation(move |url| {
            if url.host_str() != Some(BRIDGE_HOST) {
                return true;
            }
            let body = url.fragment().map(|f| percent_encoding::percent_decode_str(f).decode_utf8_lossy().to_string());
            let token = body
                .and_then(|b| serde_json::from_str::<Value>(&b).ok())
                .and_then(|v| v.pointer("/data/webapi_token").and_then(Value::as_str).map(String::from));
            let _ = tx_nav.send(token.map(Outcome::Token).unwrap_or(Outcome::SignedOut));
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    let tx_close = Arc::new(tx);
    w.on_window_event(move |e| {
        if matches!(e, WindowEvent::Destroyed) {
            let _ = tx_close.send(Outcome::Closed);
        }
    });
    Ok(w)
}

async fn run_window(app: &AppHandle, label: &str, url: &str, visible: bool, limit: Duration) -> Result<String, String> {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.set_focus();
        return Err("Steam sign-in is already open".into());
    }
    let (tx, mut rx) = mpsc::unbounded_channel();
    steam_window(app, label, url, visible, tx)?;
    let outcome = tokio::time::timeout(limit, rx.recv()).await;
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.close();
    }
    match outcome {
        Ok(Some(Outcome::Token(t))) if parse_token(&t).is_some() => Ok(t),
        Ok(Some(Outcome::Closed)) => Err("Sign-in was closed before it finished".into()),
        Ok(_) => Err("Steam session expired: sign in again".into()),
        Err(_) => Err("Steam took too long to answer".into()),
    }
}

fn save_token(app: &AppHandle, token: Option<&str>) {
    let state = app.state::<AppState>();
    let mut user = state.user.lock().unwrap();
    user.accounts.steam_signed_in = token.is_some();
    user.accounts.steam_token = token.unwrap_or_default().to_string();
    state.save_user(&user);
}

/// Opens Steam's sign-in page above Mantel and returns once the player is signed in.
pub async fn steam_sign_in(app: &AppHandle) -> Result<(), String> {
    let token = run_window(app, LOGIN_WINDOW, &format!("{STORE}/login/?redir=account%2F"), true, Duration::from_secs(15 * 60)).await?;
    save_token(app, Some(&token));
    crate::log::info("steam: signed in");
    Ok(())
}

/// A valid Web API token, renewed through a hidden store page when the old one expired.
async fn live_token(app: &AppHandle) -> Result<String, String> {
    let (signed_in, saved) = {
        let state = app.state::<AppState>();
        let user = state.user.lock().unwrap();
        (user.accounts.steam_signed_in, user.accounts.steam_token.clone())
    };
    if !signed_in {
        return Err("Not signed in to Steam".into());
    }
    if parse_token(&saved).is_some_and(|(_, exp)| exp > now() + 300) {
        return Ok(saved);
    }
    match run_window(app, RENEW_WINDOW, &format!("{STORE}/account/"), false, Duration::from_secs(30)).await {
        Ok(token) => {
            save_token(app, Some(&token));
            crate::log::info("steam: token renewed");
            Ok(token)
        }
        Err(e) => {
            if e.contains("expired") {
                save_token(app, None);
            }
            Err(e)
        }
    }
}

/// Every game on the signed-in account, with lifetime playtime across all devices.
pub async fn steam_owned(app: &AppHandle) -> Result<Vec<OwnedSteam>, String> {
    let token = live_token(app).await?;
    let (steam_id, _) = parse_token(&token).ok_or("Unreadable Steam token")?;
    let res = client()
        .get("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/")
        .query(&[
            ("access_token", token.as_str()),
            ("steamid", &steam_id.to_string()),
            ("include_appinfo", "1"),
            ("include_played_free_games", "1"),
        ])
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Steam: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Steam answered with an error ({})", res.status().as_u16()));
    }
    let body: Value = res.json().await.map_err(|e| format!("Unexpected answer from Steam: {e}"))?;
    let games = body.pointer("/response/games").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(games
        .iter()
        .filter_map(|g| {
            Some(OwnedSteam {
                appid: g.get("appid")?.as_u64()? as u32,
                name: g.get("name")?.as_str()?.to_string(),
                minutes: g.get("playtime_forever").and_then(Value::as_u64).unwrap_or(0),
                last_played: g.get("rtime_last_played").and_then(Value::as_i64).unwrap_or(0),
            })
        })
        .collect())
}

/// Forgets the account here and empties the WebView's cookie jar.
pub async fn steam_sign_out(app: &AppHandle) {
    save_token(app, None);
    let (tx, _rx) = mpsc::unbounded_channel();
    if let Ok(w) = steam_window(app, RENEW_WINDOW, "about:blank", false, tx) {
        let _ = tauri::async_runtime::spawn_blocking(move || {
            let _ = w.clear_all_browsing_data();
            let _ = w.close();
        })
        .await;
    }
}

// ---- Xbox ---------------------------------------------------------------------------
//
// Microsoft sign-in in a Mantel window, then the usual Xbox Live hops: user token, then an
// XSTS token that the title and stats services accept.

/// Mantel's own app registration (public client, personal Microsoft accounts).
const XBOX_CLIENT_ID: &str = "21eaa04f-e328-4cb4-a047-f0f9175f3690";
/// The same string at every step: Live rejects a token request whose scopes differ in
/// any way from what the player consented to.
const XBOX_SCOPE: &str = "Xboxlive.signin Xboxlive.offline_access";
// The Live endpoints, not login.microsoftonline.com: personal-account app registrations
// count as "first party" there and can't be granted Xbox Live (AADSTS65002).
const LIVE_TOKEN: &str = "https://login.live.com/oauth20_token.srf";

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct XboxSession {
    pub token: String,
    pub uhs: String,
    pub xuid: String,
    pub gamertag: String,
    pub not_after: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct XboxTitle {
    pub pfn: String,
    pub name: String,
    pub minutes: u64,
    pub last_played: i64,
    pub image: Option<String>,
    /// Store id like 9PCR3Z2MSM4T; the Xbox app opens its game page by it.
    #[serde(default)]
    pub product_id: Option<String>,
}

const LIVE_AUTHORIZE: &str = "https://login.live.com/oauth20_authorize.srf";
/// Registered as a redirect URI on the app; the sign-in window never actually loads it.
const LIVE_REDIRECT: &str = "https://login.live.com/oauth20_desktop.srf";
const XBOX_WINDOW: &str = "xbox-login";

fn ms_error(v: &Value) -> String {
    v.get("error_description")
        .or_else(|| v.get("error"))
        .and_then(Value::as_str)
        .map(|e| e.lines().next().unwrap_or(e).to_string())
        .unwrap_or_else(|| "Microsoft sign-in failed".into())
}

/// Microsoft's sign-in page in a Mantel window, as Playnite does it. The code arrives on the
/// redirect, which Mantel intercepts. (Sign-in by code at microsoft.com/link can't work:
/// that page is a Microsoft first-party app and can't grant Xbox Live to third parties.)
pub async fn xbox_sign_in(app: &AppHandle) -> Result<String, String> {
    if let Some(w) = app.get_webview_window(XBOX_WINDOW) {
        let _ = w.set_focus();
        return Err("Microsoft sign-in is already open".into());
    }
    let mut url = Url::parse(LIVE_AUTHORIZE).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", XBOX_CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("scope", XBOX_SCOPE)
        .append_pair("redirect_uri", LIVE_REDIRECT)
        .append_pair("prompt", "select_account");

    let (tx, mut rx) = mpsc::unbounded_channel::<Result<String, String>>();
    let tx_nav = tx.clone();
    let mut builder = WebviewWindowBuilder::new(app, XBOX_WINDOW, WebviewUrl::External(url));
    if let Some(args) = app.config().app.windows.first().and_then(|w| w.additional_browser_args.clone()) {
        builder = builder.additional_browser_args(&args);
    }
    let w = builder
        .title("Sign in to Xbox")
        .inner_size(980.0, 760.0)
        .center()
        .always_on_top(true)
        .on_navigation(move |u| {
            if !u.as_str().starts_with(LIVE_REDIRECT) {
                return true;
            }
            let get = |k: &str| u.query_pairs().find(|(key, _)| key == k).map(|(_, v)| v.to_string());
            let _ = tx_nav.send(match (get("code"), get("error_description").or_else(|| get("error"))) {
                (Some(code), _) => Ok(code),
                (None, Some(e)) => Err(e),
                (None, None) => Err("Microsoft sign-in failed".into()),
            });
            false
        })
        .build()
        .map_err(|e| e.to_string())?;
    let tx_close = Arc::new(tx);
    w.on_window_event(move |e| {
        if matches!(e, WindowEvent::Destroyed) {
            let _ = tx_close.send(Err("Sign-in was closed before it finished".into()));
        }
    });

    let outcome = tokio::time::timeout(Duration::from_secs(15 * 60), rx.recv()).await;
    if let Some(w) = app.get_webview_window(XBOX_WINDOW) {
        let _ = w.close();
    }
    let code = match outcome {
        Ok(Some(r)) => r?,
        _ => return Err("Microsoft sign-in timed out".into()),
    };

    let v: Value = client()
        .post(LIVE_TOKEN)
        .form(&[
            ("grant_type", "authorization_code"),
            ("client_id", XBOX_CLIENT_ID),
            ("code", &code),
            ("redirect_uri", LIVE_REDIRECT),
            ("scope", XBOX_SCOPE),
        ])
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Microsoft: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let access = v.get("access_token").and_then(Value::as_str).ok_or_else(|| ms_error(&v))?;
    let refresh = v.get("refresh_token").and_then(Value::as_str).unwrap_or_default().to_string();
    let session = xbox_live(access).await?;
    save_xbox(app, &refresh, &session);
    crate::log::info("xbox: signed in");
    Ok(session.gamertag)
}

/// Microsoft access token → Xbox Live user token → XSTS token for xboxlive.com.
async fn xbox_live(access_token: &str) -> Result<XboxSession, String> {
    let http = client();
    let user: Value = http
        .post("https://user.auth.xboxlive.com/user/authenticate")
        .header("x-xbl-contract-version", "1")
        .json(&serde_json::json!({
            "Properties": { "AuthMethod": "RPS", "SiteName": "user.auth.xboxlive.com", "RpsTicket": format!("d={access_token}") },
            "RelyingParty": "http://auth.xboxlive.com",
            "TokenType": "JWT",
        }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Xbox Live: {e}"))?
        .json()
        .await
        .map_err(|_| "Xbox Live refused the Microsoft sign-in".to_string())?;
    let user_token = user.get("Token").and_then(Value::as_str).ok_or("Xbox Live refused the Microsoft sign-in")?;

    let res = http
        .post("https://xsts.auth.xboxlive.com/xsts/authorize")
        .header("x-xbl-contract-version", "1")
        .json(&serde_json::json!({
            "Properties": { "SandboxId": "RETAIL", "UserTokens": [user_token] },
            "RelyingParty": "http://xboxlive.com",
            "TokenType": "JWT",
        }))
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Xbox Live: {e}"))?;
    if res.status().as_u16() == 401 {
        // XErr codes: no Xbox profile yet, child account, region…
        let body: Value = res.json().await.unwrap_or_default();
        return Err(match body.get("XErr").and_then(Value::as_u64) {
            Some(2148916233) => "This Microsoft account has no Xbox profile yet. Create one at xbox.com first.".into(),
            Some(2148916238) => "Child accounts need a parent's permission for Xbox Live.".into(),
            _ => "Xbox Live refused the sign-in".into(),
        });
    }
    let xsts: Value = res.json().await.map_err(|e| e.to_string())?;
    let claims = xsts.pointer("/DisplayClaims/xui/0").ok_or("Xbox Live sent no profile")?;
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or_default().to_string();
    Ok(XboxSession {
        token: s(&xsts, "Token"),
        uhs: s(claims, "uhs"),
        xuid: s(claims, "xid"),
        gamertag: s(claims, "gtg"),
        not_after: parse_iso(&s(&xsts, "NotAfter")).unwrap_or_else(|| now() + 3600),
    })
}

fn save_xbox(app: &AppHandle, refresh: &str, session: &XboxSession) {
    let state = app.state::<AppState>();
    let mut user = state.user.lock().unwrap();
    if !refresh.is_empty() {
        user.accounts.xbox_refresh = refresh.to_string();
    }
    user.accounts.xbox_gamertag = session.gamertag.clone();
    user.accounts.xbox_session = session.clone();
    state.save_user(&user);
}

/// A live XSTS session, refreshed through the Microsoft refresh token when it expires.
async fn xbox_session(app: &AppHandle) -> Result<XboxSession, String> {
    let (refresh, session) = {
        let state = app.state::<AppState>();
        let user = state.user.lock().unwrap();
        (user.accounts.xbox_refresh.clone(), user.accounts.xbox_session.clone())
    };
    if refresh.is_empty() {
        return Err("Not signed in to Xbox".into());
    }
    if session.not_after > now() + 300 && !session.token.is_empty() {
        return Ok(session);
    }
    let v: Value = client()
        .post(LIVE_TOKEN)
        .form(&[("grant_type", "refresh_token"), ("client_id", XBOX_CLIENT_ID), ("refresh_token", &refresh), ("scope", XBOX_SCOPE)])
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Microsoft: {e}"))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let access = v.get("access_token").and_then(Value::as_str).ok_or_else(|| format!("Xbox sign-in expired: {}", ms_error(&v)))?;
    let next_refresh = v.get("refresh_token").and_then(Value::as_str).unwrap_or(&refresh).to_string();
    let session = xbox_live(access).await?;
    save_xbox(app, &next_refresh, &session);
    crate::log::info("xbox: session refreshed");
    Ok(session)
}

/// PC games on the account with last-played times and minutes played.
pub async fn xbox_titles(app: &AppHandle) -> Result<Vec<XboxTitle>, String> {
    let session = xbox_session(app).await?;
    let auth = format!("XBL3.0 x={};{}", session.uhs, session.token);
    let http = client();
    let history: Value = http
        .get(format!("https://titlehub.xboxlive.com/users/xuid({})/titles/titlehistory/decoration/detail,image", session.xuid))
        .header("Authorization", &auth)
        .header("x-xbl-contract-version", "2")
        .header("Accept-Language", "en-US")
        .send()
        .await
        .map_err(|e| format!("Couldn't reach Xbox Live: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Unexpected answer from Xbox Live: {e}"))?;
    let titles: Vec<&Value> = history
        .get("titles")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter(|t| t.get("type").and_then(Value::as_str) == Some("Game"))
                .filter(|t| t.get("pfn").and_then(Value::as_str).is_some_and(|p| !p.is_empty()))
                .filter(|t| t.get("devices").and_then(Value::as_array).is_some_and(|d| d.iter().any(|x| x.as_str() == Some("PC"))))
                .collect()
        })
        .unwrap_or_default();

    let ids: Vec<&str> = titles.iter().filter_map(|t| t.get("titleId").and_then(Value::as_str)).collect();
    let minutes = if ids.is_empty() { Default::default() } else { xbox_minutes(&http, &auth, &session.xuid, &ids).await };

    Ok(titles
        .iter()
        .filter_map(|t| {
            let id = t.get("titleId").and_then(Value::as_str).unwrap_or_default();
            Some(XboxTitle {
                pfn: t.get("pfn")?.as_str()?.to_string(),
                name: t.get("name")?.as_str()?.replace("(PC)", "").trim().to_string(),
                minutes: minutes.get(id).copied().unwrap_or(0),
                last_played: t.pointer("/titleHistory/lastTimePlayed").and_then(Value::as_str).and_then(parse_iso).unwrap_or(0),
                image: t.get("displayImage").and_then(Value::as_str).map(String::from),
                product_id: t
                    .pointer("/detail/availabilities")
                    .and_then(Value::as_array)
                    .and_then(|a| a.iter().find_map(|x| x.get("ProductId")?.as_str().filter(|p| !p.is_empty())))
                    .map(String::from),
            })
        })
        .collect())
}

/// Minutes played per title id. Missing for some accounts; then playtime stays local.
async fn xbox_minutes(http: &reqwest::Client, auth: &str, xuid: &str, ids: &[&str]) -> std::collections::HashMap<String, u64> {
    let body = serde_json::json!({
        "arrangebyfield": "xuid",
        "xuids": [xuid],
        "stats": ids.iter().map(|id| serde_json::json!({ "name": "MinutesPlayed", "titleid": id })).collect::<Vec<_>>(),
    });
    let res = http
        .post("https://userstats.xboxlive.com/batch")
        .header("Authorization", auth)
        .header("x-xbl-contract-version", "2")
        .json(&body)
        .send()
        .await;
    let Ok(res) = res else { return Default::default() };
    let v: Value = res.json().await.unwrap_or_default();
    v.pointer("/statlistscollection/0/stats")
        .and_then(Value::as_array)
        .map(|stats| {
            stats
                .iter()
                .filter_map(|s| {
                    let id = s.get("titleid")?.as_str()?.to_string();
                    let value = s.get("value")?.as_str()?.parse().ok()?;
                    Some((id, value))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Installed games gain account playtime; the rest open their page in the Xbox app to
/// install, or the Microsoft Store when Live sent no store id.
pub fn merge_xbox(games: &mut Vec<Game>, titles: &[XboxTitle]) {
    for t in titles {
        let last = (t.last_played > 0).then_some(t.last_played);
        if let Some(g) = games.iter_mut().find(|g| g.source == "xbox" && g.source_id.eq_ignore_ascii_case(&t.pfn)) {
            g.playtime_minutes = g.playtime_minutes.max(t.minutes);
            g.last_played = g.last_played.max(last);
            continue;
        }
        let uri = match &t.product_id {
            Some(id) => format!("msxbox://game/?productId={id}"),
            None => format!("ms-windows-store://pdp/?PFN={}", t.pfn),
        };
        let mut g = Game::new("xbox", t.pfn.clone(), t.name.clone(), Launch::Uri { uri });
        g.installed = false;
        g.playtime_minutes = t.minutes;
        g.last_played = last;
        g.art.cover.extend(t.image.clone());
        games.push(g);
    }
}

/// `2026-10-28T12:34:56.1234567Z` → unix seconds (UTC only, which is all Xbox Live sends).
fn parse_iso(s: &str) -> Option<i64> {
    let (date, time) = s.split_once('T')?;
    let mut d = date.split('-').map(|x| x.parse::<i64>());
    let (y, m, day) = (d.next()?.ok()?, d.next()?.ok()?, d.next()?.ok()?);
    let mut t = time.trim_end_matches('Z').split(':');
    let (h, min) = (t.next()?.parse::<i64>().ok()?, t.next()?.parse::<i64>().ok()?);
    let sec = t.next().and_then(|x| x.split('.').next()?.parse::<i64>().ok()).unwrap_or(0);
    // Days from civil (Howard Hinnant).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((m + 9) % 12) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146097 + doe - 719468) * 86400 + h * 3600 + min * 60 + sec)
}

/// Folds account data into a scan: better playtime for installed games, and entries
/// for the rest that open Steam's install dialog.
pub fn merge_steam(games: &mut Vec<Game>, owned: &[OwnedSteam]) {
    for o in owned {
        let id = format!("steam:{}", o.appid);
        let last = (o.last_played > 0).then_some(o.last_played);
        if let Some(g) = games.iter_mut().find(|g| g.id == id) {
            g.playtime_minutes = g.playtime_minutes.max(o.minutes);
            g.last_played = g.last_played.max(last);
            continue;
        }
        let mut g = Game::new("steam", o.appid.to_string(), o.name.clone(), Launch::Uri { uri: format!("steam://install/{}", o.appid) });
        g.installed = false;
        g.steam_app_id = Some(o.appid);
        g.art = steam_cdn_art(o.appid);
        g.playtime_minutes = o.minutes;
        g.last_played = last;
        games.push(g);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_xbox_dates() {
        assert_eq!(parse_iso("1970-01-02T00:00:00Z"), Some(86400));
        assert_eq!(parse_iso("2026-10-28T12:34:56.1234567Z"), Some(1793190896));
    }

    #[test]
    fn reads_web_api_token() {
        let claims = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(br#"{"sub":"76561198000000000","exp":2000000000}"#);
        assert_eq!(parse_token(&format!("h.{claims}.s")), Some((76561198000000000, 2000000000)));
    }
}
