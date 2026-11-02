//! Online lookups: artwork for non-Steam games and store details for the game page.

use std::collections::HashMap;
use std::time::Duration;

use futures::stream::{self, StreamExt};
use serde::Serialize;
use serde_json::{json, Value};

use crate::library::steam_cdn_art;
use crate::model::{now, Art};
use crate::store::ResolvedArt;

pub struct Lookup {
    pub id: String,
    pub source: String,
    pub source_id: String,
    pub name: String,
}

pub fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .user_agent("Mantel/0.1 (game launcher)")
        .build()
        .unwrap_or_default()
}

pub async fn resolve(games: Vec<Lookup>, sgdb_key: String) -> HashMap<String, ResolvedArt> {
    let http = client();
    stream::iter(games)
        .map(|g| {
            let http = http.clone();
            let key = sgdb_key.clone();
            async move {
                let mut art = Art::default();
                if !key.is_empty() {
                    if let Some(a) = steamgriddb(&http, &key, &g.name).await {
                        art.extend(&a);
                    }
                }
                if g.source == "gog" {
                    if let Some(a) = gog(&http, &g.source_id).await {
                        art.extend(&a);
                    }
                }
                let steam_app_id = steam_search(&http, &g.name).await;
                if let Some(appid) = steam_app_id {
                    art.extend(&steam_cdn_art(appid));
                }
                (g.id, ResolvedArt { art, steam_app_id, at: now() })
            }
        })
        .buffer_unordered(6)
        .collect()
        .await
}

/// Lowercase alphanumerics only, so "DOOM Eternal™" and "Doom Eternal" compare equal.
fn normalize(name: &str) -> String {
    name.to_lowercase()
        .replace('&', " and ")
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn names_match(ours: &str, theirs: &str) -> bool {
    let (a, b) = (normalize(ours), normalize(theirs));
    if a.is_empty() || b.is_empty() {
        return false;
    }
    // Store names often add or drop an edition suffix.
    a == b || (b.len() >= 4 && a.starts_with(&b)) || (a.len() >= 4 && b.starts_with(&a))
}

pub async fn get_json(req: reqwest::RequestBuilder) -> Option<Value> {
    let res = req.send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json().await.ok()
}

async fn steam_apps(http: &reqwest::Client, name: &str) -> Option<Vec<(String, u32)>> {
    let req = http
        .get("https://store.steampowered.com/api/storesearch/")
        .query(&[("term", name), ("l", "english"), ("cc", "US")]);
    let v = get_json(req).await?;
    let items = v.get("items")?.as_array()?;
    Some(
        items
            .iter()
            .filter(|i| i.get("type").and_then(Value::as_str) == Some("app"))
            .filter_map(|i| Some((i.get("name")?.as_str()?.to_string(), i.get("id")?.as_u64()? as u32)))
            .collect(),
    )
}

pub async fn steam_search(http: &reqwest::Client, name: &str) -> Option<u32> {
    let candidates = steam_apps(http, name).await?;
    candidates
        .iter()
        .find(|(n, _)| normalize(n) == normalize(name))
        .or_else(|| candidates.iter().find(|(n, _)| names_match(name, n)))
        .map(|&(_, id)| id)
}

/// Words a store title can end on without naming a different game.
const EDITION_WORDS: &[&str] =
    &["standard", "deluxe", "ultimate", "gold", "complete", "definitive", "goty", "game", "of", "the", "year", "crossgen", "edition", "bundle", "for", "windows", "pc", "launcher", "elite", ""];

/// A store title without its edition: "Avowed Standard Edition" is plain "Avowed" on Steam.
fn base_title(name: &str) -> String {
    let mut words: Vec<&str> = name.split_whitespace().collect();
    while words.len() > 1 && EDITION_WORDS.contains(&normalize(words[words.len() - 1]).as_str()) {
        words.pop();
    }
    words.join(" ")
}

/// Logos for a game Mantel only knows by name, for its page before it's installed. Exact names
/// only, unlike the library's lookups: a sequel would otherwise wear the first game's logo. Steam
/// has no logo at its usual address for many newer games, so each is checked before it's offered.
pub async fn find_logo(name: &str, sgdb_key: &str) -> Vec<String> {
    let http = client();
    let title = base_title(name);
    let (community, steam) = futures::join!(sgdb_logos(&http, sgdb_key, &title), steam_logo(&http, &title));
    community.into_iter().chain(steam).collect()
}

/// The Steam app with exactly this name, edition aside. For showing things as this game's own,
/// where the first game's would be wrong for a sequel.
pub async fn steam_exact(http: &reqwest::Client, name: &str) -> Option<u32> {
    let title = base_title(name);
    let apps = steam_apps(http, &title).await?;
    apps.iter().find(|(n, _)| normalize(n) == normalize(&title)).map(|&(_, id)| id)
}

async fn steam_logo(http: &reqwest::Client, title: &str) -> Option<String> {
    let appid = steam_exact(http, title).await?;
    let url = steam_cdn_art(appid).logo.into_iter().next()?;
    http.head(&url).send().await.ok()?.status().is_success().then_some(url)
}

async fn sgdb_logos(http: &reqwest::Client, key: &str, title: &str) -> Vec<String> {
    if key.is_empty() {
        return Vec::new();
    }
    let auth = format!("Bearer {key}");
    let list = sgdb_search(http, &auth, title).await.unwrap_or_default();
    let Some(gid) = list.iter().find(|g| g.get("name").and_then(Value::as_str).is_some_and(|n| normalize(n) == normalize(title))).and_then(|g| g.get("id")?.as_u64()) else {
        return Vec::new();
    };
    sgdb_urls(get_json(http.get(format!("{SGDB}/logos/game/{gid}")).query(&[("types", "static")]).header("Authorization", &auth)).await)
}

async fn gog(http: &reqwest::Client, id: &str) -> Option<Art> {
    let v = get_json(http.get(format!("https://api.gog.com/v2/games/{id}")).query(&[("locale", "en-US")])).await?;
    let links = v.get("_links")?;
    let href = |k: &str| links.get(k).and_then(|l| l.get("href")).and_then(Value::as_str).map(String::from);
    Some(Art {
        cover: href("boxArtImage").into_iter().collect(),
        hero: [href("galaxyBackgroundImage"), href("backgroundImage")].into_iter().flatten().collect(),
        logo: href("logo").into_iter().collect(),
        icon: href("iconSquare").into_iter().collect(),
    })
}

const SGDB: &str = "https://www.steamgriddb.com/api/v2";

/// The SteamGridDB game for a name. `loose` settles for the top result when no name matches,
/// which is fine when the player looks at what comes back, not for picking art unseen.
async fn sgdb_game(http: &reqwest::Client, auth: &str, name: &str, loose: bool) -> Option<u64> {
    let list = sgdb_search(http, auth, name).await?;
    let game = list
        .iter()
        .find(|g| g.get("name").and_then(Value::as_str).is_some_and(|n| names_match(name, n)))
        .or(if loose { list.first() } else { None })?;
    game.get("id")?.as_u64()
}

async fn sgdb_search(http: &reqwest::Client, auth: &str, name: &str) -> Option<Vec<Value>> {
    let mut search = reqwest::Url::parse(&format!("{SGDB}/search/autocomplete")).ok()?;
    search.path_segments_mut().ok()?.push(name);
    let found = get_json(http.get(search).header("Authorization", auth)).await?;
    found.get("data")?.as_array().cloned()
}

fn sgdb_urls(v: Option<Value>) -> Vec<String> {
    v.and_then(|v| v.get("data").cloned())
        .and_then(|d| d.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(|i| i.get("url").and_then(Value::as_str).map(String::from))
        .take(2)
        .collect()
}

async fn steamgriddb(http: &reqwest::Client, key: &str, name: &str) -> Option<Art> {
    let auth = format!("Bearer {key}");
    let gid = sgdb_game(http, &auth, name, false).await?;

    let (grids, heroes, logos) = futures::join!(
        get_json(http.get(format!("{SGDB}/grids/game/{gid}")).query(&[("dimensions", "600x900"), ("types", "static")]).header("Authorization", &auth)),
        get_json(http.get(format!("{SGDB}/heroes/game/{gid}")).query(&[("types", "static")]).header("Authorization", &auth)),
        get_json(http.get(format!("{SGDB}/logos/game/{gid}")).query(&[("types", "static")]).header("Authorization", &auth)),
    );
    Some(Art { cover: sgdb_urls(grids), hero: sgdb_urls(heroes), logo: sgdb_urls(logos), icon: Vec::new() })
}

#[derive(Debug, Clone, Serialize)]
pub struct Choice {
    pub url: String,
    pub thumb: String,
}

/// SteamGridDB's images of one kind for a game, best rated first, for the player to pick from.
pub async fn choices(key: &str, kind: &str, steam_app_id: Option<u32>, name: &str) -> Result<Vec<Choice>, String> {
    let (path, dimensions) = match kind {
        "cover" => ("grids", Some("600x900,342x482,660x930")),
        "hero" => ("heroes", None),
        "logo" => ("logos", None),
        other => return Err(format!("Unknown kind of art: {other}")),
    };
    let http = client();
    let auth = format!("Bearer {key}");
    let list = |game: String| {
        let mut req = http
            .get(format!("{SGDB}/{path}/{game}"))
            .query(&[("types", "static"), ("nsfw", "false"), ("humor", "false")])
            .header("Authorization", &auth);
        if let Some(d) = dimensions {
            req = req.query(&[("dimensions", d)]);
        }
        async move {
            get_json(req).await.and_then(|v| v.get("data")?.as_array().cloned()).unwrap_or_default()
        }
    };
    // Steam games by app id; others, and Steam games SteamGridDB has nothing for, by name.
    let mut found = match steam_app_id {
        Some(appid) => list(format!("steam/{appid}")).await,
        None => Vec::new(),
    };
    if found.is_empty() {
        let gid = sgdb_game(&http, &auth, name, true).await.ok_or_else(|| format!("SteamGridDB has nothing for {name}"))?;
        found = list(format!("game/{gid}")).await;
    }
    Ok(found
        .iter()
        .filter_map(|i| {
            let url = i.get("url")?.as_str()?.to_string();
            let thumb = i.get("thumb").and_then(Value::as_str).map(String::from).unwrap_or_else(|| url.clone());
            Some(Choice { url, thumb })
        })
        .take(60)
        .collect())
}

/// The game's main trailer as a DASH manifest: Steam serves trailers only as DASH or HLS.
/// Steam's trailers for the page's media rail, in the shape the catalog's come in.
fn videos(d: &Value) -> Vec<Value> {
    let movies = d.get("movies").and_then(Value::as_array).cloned().unwrap_or_default();
    movies
        .iter()
        .filter_map(|m| Some(json!({ "url": m.get("dash_h264")?.as_str()?, "thumb": m.get("thumbnail"), "title": m.get("name") })))
        .take(6)
        .collect()
}

/// What Steam says about how a game plays, in the requested language: single player, co-op,
/// controller support and the like, without its storefront extras.
fn features(d: &Value) -> Vec<Value> {
    const WANTED: &[u64] = &[2, 1, 38, 9, 39, 24, 27, 28, 18, 23, 22];
    let list = d.get("categories").and_then(Value::as_array).cloned().unwrap_or_default();
    WANTED
        .iter()
        .filter_map(|id| list.iter().find(|c| c.get("id").and_then(Value::as_u64) == Some(*id))?.get("description").cloned())
        .collect()
}

fn trailer(d: &Value) -> Option<String> {
    let movies = d.get("movies")?.as_array()?;
    let pick = movies.iter().find(|m| m.get("highlight").and_then(Value::as_bool) == Some(true)).or(movies.first())?;
    pick.get("dash_h264")?.as_str().map(String::from)
}

/// Description, genres, screenshots and the trailer from the Steam store.
pub async fn steam_details(appid: u32, language: &str) -> Option<Value> {
    let req = client()
        .get("https://store.steampowered.com/api/appdetails")
        .query(&[("appids", appid.to_string()), ("l", language.to_string())]);
    let v = get_json(req).await?;
    let d = v.get(appid.to_string())?.get("data")?;
    let list = |key: &str, field: &str| -> Vec<Value> {
        d.get(key)
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.get(field).cloned()).collect())
            .unwrap_or_default()
    };
    Some(json!({
        "description": d.get("short_description"),
        "genres": list("genres", "description"),
        "developers": d.get("developers"),
        "publishers": d.get("publishers"),
        "releaseDate": d.get("release_date").and_then(|r| r.get("date")),
        "metacritic": d.get("metacritic").and_then(|m| m.get("score")),
        "screenshots": list("screenshots", "path_full").into_iter().take(10).collect::<Vec<_>>(),
        "background": d.get("background_raw"),
        "trailer": trailer(d),
        "videos": videos(d),
        "features": features(d),
        "language": language,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_editions_from_titles() {
        assert_eq!(base_title("Avowed Standard Edition"), "Avowed");
        assert_eq!(base_title("Call of Duty®: Black Ops 7 - Cross-Gen Bundle"), "Call of Duty®: Black Ops 7");
        assert_eq!(base_title("Fallout 4: Game of the Year Edition"), "Fallout 4:");
        assert_eq!(base_title("Minecraft Dungeons II"), "Minecraft Dungeons II");
        assert_eq!(base_title("Gold"), "Gold");
    }
}
