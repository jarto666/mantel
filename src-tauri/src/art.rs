//! Online lookups: artwork for non-Steam games and store details for the game page.

use std::collections::HashMap;
use std::time::Duration;

use futures::stream::{self, StreamExt};
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

fn client() -> reqwest::Client {
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

async fn get_json(req: reqwest::RequestBuilder) -> Option<Value> {
    let res = req.send().await.ok()?;
    if !res.status().is_success() {
        return None;
    }
    res.json().await.ok()
}

async fn steam_search(http: &reqwest::Client, name: &str) -> Option<u32> {
    let req = http
        .get("https://store.steampowered.com/api/storesearch/")
        .query(&[("term", name), ("l", "english"), ("cc", "US")]);
    let v = get_json(req).await?;
    let items = v.get("items")?.as_array()?;
    let candidates: Vec<(&str, u32)> = items
        .iter()
        .filter(|i| i.get("type").and_then(Value::as_str) == Some("app"))
        .filter_map(|i| Some((i.get("name")?.as_str()?, i.get("id")?.as_u64()? as u32)))
        .collect();
    candidates
        .iter()
        .find(|(n, _)| normalize(n) == normalize(name))
        .or_else(|| candidates.iter().find(|(n, _)| names_match(name, n)))
        .map(|&(_, id)| id)
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

async fn steamgriddb(http: &reqwest::Client, key: &str, name: &str) -> Option<Art> {
    let api = "https://www.steamgriddb.com/api/v2";
    let auth = format!("Bearer {key}");
    let mut search = reqwest::Url::parse(&format!("{api}/search/autocomplete")).ok()?;
    search.path_segments_mut().ok()?.push(name);
    let found = get_json(http.get(search).header("Authorization", &auth)).await?;
    let game = found.get("data")?.as_array()?.iter().find(|g| {
        g.get("name").and_then(Value::as_str).is_some_and(|n| names_match(name, n))
    })?;
    let gid = game.get("id")?.as_u64()?;

    let urls = |v: Option<Value>| -> Vec<String> {
        v.and_then(|v| v.get("data").cloned())
            .and_then(|d| d.as_array().cloned())
            .unwrap_or_default()
            .iter()
            .filter_map(|i| i.get("url").and_then(Value::as_str).map(String::from))
            .take(2)
            .collect()
    };
    let (grids, heroes, logos) = futures::join!(
        get_json(http.get(format!("{api}/grids/game/{gid}")).query(&[("dimensions", "600x900"), ("types", "static")]).header("Authorization", &auth)),
        get_json(http.get(format!("{api}/heroes/game/{gid}")).query(&[("types", "static")]).header("Authorization", &auth)),
        get_json(http.get(format!("{api}/logos/game/{gid}")).query(&[("types", "static")]).header("Authorization", &auth)),
    );
    Some(Art { cover: urls(grids), hero: urls(heroes), logo: urls(logos), icon: Vec::new() })
}

/// Description, genres and screenshots from the Steam store.
pub async fn steam_details(appid: u32) -> Option<Value> {
    let req = client()
        .get("https://store.steampowered.com/api/appdetails")
        .query(&[("appids", appid.to_string()), ("l", "english".into())]);
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
    }))
}
