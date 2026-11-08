//! What Steam's public store says, no key needed: art and genres of any games in one go, and the
//! lists to browse. Buying stays on Steam's own page. Prices come from the store's own answer, in
//! the player's currency, since item data only prices for a country Mantel would have to guess.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::art::{client, get_json};
use crate::library::steam_cdn_art;
use crate::model::{now, Art, Game, Launch};

const ITEMS: &str = "https://api.steampowered.com/IStoreBrowseService/GetItems/v1";
const ASSETS: &str = "https://shared.fastly.steamstatic.com/store_item_assets/";
/// Item data asked for at once; the query goes in the URL.
const BATCH: usize = 100;
/// How often search asks for more; Steam answers with fewer than this when it runs out.
const PAGE: u32 = 50;
/// Art paths change when a game's art does, so facts about it age out.
const FRESH_SECS: i64 = 30 * 24 * 3600;
/// Steam's tags broad enough to be a genre, in the order the filters show them.
const GENRES: &[u32] = &[19, 21, 122, 9, 599, 1774, 699, 701, 1664, 1625, 1662, 1667, 1743, 597, 492, 1695, 1716];
/// The lists on the store's front page: our id, the shelf's title, Steam's key.
const LISTS: &[(&str, &str, &str)] = &[("top", "Top sellers", "top_sellers"), ("new", "New releases", "new_releases"), ("deals", "Deals", "specials"), ("soon", "Coming soon", "coming_soon")];

/// What Steam says about one game in the library.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppFacts {
    pub at: i64,
    pub genres: Vec<u32>,
    pub art: Art,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Facts {
    pub apps: HashMap<u32, AppFacts>,
    pub language: String,
    pub names: HashMap<u32, String>,
}

impl Facts {
    /// A game from another store that matched a Steam page keeps the genres its own store gave.
    pub fn apply(&self, game: &mut Game) {
        let Some(app) = game.steam_app_id.and_then(|id| self.apps.get(&id)) else { return };
        if game.source == "steam" || game.genres.is_empty() {
            game.genres = app.genres.iter().filter_map(|tag| self.names.get(tag).cloned()).collect();
        }
        // New games' art has a hash in its path, so the plain addresses in front of it can miss.
        game.art.extend(&app.art);
    }

    /// Of these Steam apps, the ones Steam hasn't been asked about lately.
    pub fn missing(&self, ids: impl IntoIterator<Item = u32>) -> Vec<u32> {
        let t = now();
        let mut todo: Vec<u32> = ids.into_iter().filter(|id| self.apps.get(id).is_none_or(|a| t - a.at > FRESH_SECS)).collect();
        todo.sort_unstable();
        todo.dedup();
        todo
    }
}

#[derive(Debug, Serialize)]
pub struct Shelf {
    id: &'static str,
    title: &'static str,
    games: Vec<Game>,
}

#[derive(Debug, Serialize)]
pub struct Genre {
    tag: u32,
    name: String,
}

#[derive(Debug, Serialize)]
pub struct Home {
    shelves: Vec<Shelf>,
    genres: Vec<Genre>,
}

#[derive(Debug, Serialize)]
pub struct Page {
    games: Vec<Game>,
    more: bool,
}

/// Item data for these apps, in no particular order. None if Steam couldn't be reached.
async fn items(ids: &[u32], language: &str) -> Option<Vec<Value>> {
    let mut found = Vec::new();
    for batch in ids.chunks(BATCH) {
        let query = json!({
            "ids": batch.iter().map(|appid| json!({ "appid": appid })).collect::<Vec<_>>(),
            // Required, and nothing here depends on it.
            "context": { "language": language, "country_code": "US" },
            "data_request": { "include_assets": true, "include_tag_count": 20 },
        });
        let answer = get_json(client().get(ITEMS).query(&[("input_json", query.to_string())])).await?;
        let list = answer.pointer("/response/store_items")?.as_array()?;
        found.extend(list.iter().filter(|i| i.get("success").and_then(Value::as_u64) == Some(1)).cloned());
    }
    Some(found)
}

fn appid_of(item: &Value) -> Option<u32> {
    item.get("appid")?.as_u64().map(|id| id as u32)
}

fn art_of(item: &Value) -> Art {
    let Some(assets) = item.get("assets") else { return Art::default() };
    let format = assets.get("asset_url_format").and_then(Value::as_str).unwrap_or_default();
    let urls = |keys: &[&str]| -> Vec<String> {
        keys.iter().filter_map(|k| assets.get(k).and_then(Value::as_str)).map(|file| format!("{ASSETS}{}", format.replace("${FILENAME}", file))).collect()
    };
    Art {
        cover: urls(&["library_capsule_2x", "library_capsule"]),
        hero: urls(&["library_hero_2x", "library_hero", "page_background", "header_2x", "header"]),
        logo: Vec::new(),
        icon: urls(&["header"]),
    }
}

/// The genres among an item's tags, the ones players tag it with most first.
fn genres_of(item: &Value) -> Vec<u32> {
    let Some(tags) = item.get("tagids").and_then(Value::as_array) else { return Vec::new() };
    tags.iter().filter_map(|t| t.as_u64().map(|t| t as u32)).filter(|t| GENRES.contains(t)).collect()
}

/// Facts about these games. Those Steam has nothing on get empty ones, so they aren't asked about
/// on every start. None if Steam couldn't be reached.
pub async fn facts(ids: &[u32], language: &str) -> Option<HashMap<u32, AppFacts>> {
    let at = now();
    let mut out: HashMap<u32, AppFacts> = ids.iter().map(|id| (*id, AppFacts { at, ..Default::default() })).collect();
    for item in items(ids, language).await? {
        if let Some(id) = appid_of(&item) {
            out.insert(id, AppFacts { at, genres: genres_of(&item), art: art_of(&item) });
        }
    }
    Some(out)
}

/// The genres' names in `language`.
pub async fn genre_names(language: &str) -> Option<HashMap<u32, String>> {
    let answer = get_json(client().get(format!("https://store.steampowered.com/tagdata/populartags/{language}"))).await?;
    Some(
        answer
            .as_array()?
            .iter()
            .filter_map(|t| Some((t.get("tagid")?.as_u64()? as u32, t.get("name")?.as_str()?.to_string())))
            .filter(|(tag, _)| GENRES.contains(tag))
            .collect(),
    )
}

/// Prices and discounts in the player's currency. Free games and unreleased ones have none.
async fn prices(ids: &[u32]) -> HashMap<u32, (String, u8)> {
    let mut out = HashMap::new();
    for batch in ids.chunks(BATCH) {
        let list = batch.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let req = client().get("https://store.steampowered.com/api/appdetails").query(&[("appids", list.as_str()), ("filters", "price_overview")]);
        let Some(answer) = get_json(req).await else { continue };
        for id in batch {
            let Some(price) = answer.pointer(&format!("/{id}/data/price_overview")) else { continue };
            let Some(text) = price.get("final_formatted").and_then(Value::as_str) else { continue };
            out.insert(*id, (text.to_string(), price.get("discount_percent").and_then(Value::as_u64).unwrap_or(0) as u8));
        }
    }
    out
}

/// A store entry as a game: not in the library, and it opens on Steam.
fn game_of(item: &Value, names: &HashMap<u32, String>, prices: &HashMap<u32, (String, u8)>) -> Option<Game> {
    // Hardware, software and DLC sell on the same lists.
    if item.get("type").and_then(Value::as_u64).unwrap_or(0) != 0 {
        return None;
    }
    let appid = appid_of(item)?;
    let mut game = Game::new("steam", appid.to_string(), item.get("name")?.as_str()?, Launch::Uri { uri: format!("steam://store/{appid}") });
    game.installed = false;
    game.steam_app_id = Some(appid);
    game.art = art_of(item);
    game.art.extend(&steam_cdn_art(appid));
    game.tags = vec!["store".to_string()];
    game.genres = genres_of(item).iter().filter_map(|tag| names.get(tag).cloned()).collect();
    if let Some((price, discount)) = prices.get(&appid) {
        game.price = Some(price.clone());
        game.discount = (*discount > 0).then_some(*discount);
    } else if item.get("is_free").and_then(Value::as_bool) == Some(true) {
        game.price = Some("Free".to_string());
    }
    Some(game)
}

/// These apps as games, in the order given.
async fn games_of(ids: &[u32], language: &str, names: &HashMap<u32, String>) -> Option<Vec<Game>> {
    let (found, prices) = futures::join!(items(ids, language), prices(ids));
    let by_id: HashMap<u32, Value> = found?.into_iter().filter_map(|i| Some((appid_of(&i)?, i))).collect();
    Some(ids.iter().filter_map(|id| game_of(by_id.get(id)?, names, &prices)).collect())
}

fn unique(ids: impl IntoIterator<Item = u32>) -> Vec<u32> {
    let mut seen = HashSet::new();
    ids.into_iter().filter(|id| seen.insert(*id)).collect()
}

/// The store's front page and the genres to filter by.
pub async fn home(language: &str) -> Result<Home, String> {
    const UNREACHABLE: &str = "Couldn't reach Steam";
    let answer = get_json(client().get("https://store.steampowered.com/api/featuredcategories").query(&[("l", language)])).await.ok_or(UNREACHABLE)?;
    let listed = |key: &str| -> Vec<u32> {
        let items = answer.pointer(&format!("/{key}/items")).and_then(Value::as_array);
        unique(items.into_iter().flatten().filter_map(|i| i.get("id")?.as_u64().map(|id| id as u32)))
    };
    let all = unique(LISTS.iter().flat_map(|(_, _, key)| listed(key)));
    let names = genre_names(language).await.unwrap_or_default();
    let games = games_of(&all, language, &names).await.ok_or(UNREACHABLE)?;
    let shelves = LISTS
        .iter()
        .map(|(id, title, key)| {
            let on_it = listed(key);
            let mut games: Vec<Game> = games.iter().filter(|g| g.steam_app_id.is_some_and(|a| on_it.contains(&a))).cloned().collect();
            games.sort_by_key(|g| on_it.iter().position(|a| Some(*a) == g.steam_app_id));
            Shelf { id, title, games }
        })
        .collect();
    let genres = GENRES.iter().filter_map(|tag| Some(Genre { tag: *tag, name: names.get(tag)?.clone() })).collect();
    Ok(Home { shelves, genres })
}

/// The app id in a search result's image address; bundles and packages have none.
fn appid_in_logo(logo: &str) -> Option<u32> {
    let rest = &logo[logo.find("/apps/")? + "/apps/".len()..];
    rest.split('/').next()?.parse().ok()
}

/// The store's games by name. Add-ons match too, and drop out with everything else that isn't a game.
pub async fn search(query: &str, language: &str) -> Result<Vec<Game>, String> {
    const UNREACHABLE: &str = "Couldn't reach Steam";
    let answer = get_json(client().get("https://store.steampowered.com/api/storesearch/").query(&[("term", query), ("l", language), ("cc", "US")])).await.ok_or(UNREACHABLE)?;
    let ids = unique(answer.get("items").and_then(Value::as_array).into_iter().flatten().filter(|i| i.get("type").and_then(Value::as_str) == Some("app")).filter_map(|i| i.get("id")?.as_u64().map(|id| id as u32)));
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let names = genre_names(language).await.unwrap_or_default();
    games_of(&ids, language, &names).await.ok_or_else(|| UNREACHABLE.to_string())
}

/// One page of a store list, all games if `tag` is None.
pub async fn page(list: &str, tag: Option<u32>, start: u32, language: &str) -> Result<Page, String> {
    let mut query: Vec<(&str, String)> = vec![("json", "1".into()), ("category1", "998".into()), ("count", PAGE.to_string()), ("start", start.to_string()), ("l", language.into())];
    query.extend(match list {
        "new" => vec![("filter", "popularnew".to_string()), ("sort_by", "Released_DESC".to_string())],
        "deals" => vec![("specials", "1".to_string())],
        "soon" => vec![("filter", "popularcomingsoon".to_string())],
        _ => vec![("filter", "topsellers".to_string())],
    });
    if let Some(tag) = tag {
        query.push(("tags", tag.to_string()));
    }
    let answer = get_json(client().get("https://store.steampowered.com/search/results/").query(&query)).await.ok_or("Couldn't reach Steam")?;
    let results = answer.get("items").and_then(Value::as_array).ok_or("Couldn't reach Steam")?;
    let ids = unique(results.iter().filter_map(|i| appid_in_logo(i.get("logo")?.as_str()?)));
    let names = genre_names(language).await.unwrap_or_default();
    let games = if ids.is_empty() { Vec::new() } else { games_of(&ids, language, &names).await.ok_or("Couldn't reach Steam")? };
    Ok(Page { games, more: !results.is_empty() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_app_in_a_search_logo() {
        assert_eq!(appid_in_logo("https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/4115450/aef06490/capsule_sm_120.jpg?t=1"), Some(4115450));
        assert_eq!(appid_in_logo("https://shared.fastly.steamstatic.com/store_item_assets/steam/bundles/123/x/capsule.jpg"), None);
    }

    #[test]
    fn hashed_art_reaches_games_from_other_stores() {
        use crate::model::Launch;
        let hashed = format!("{ASSETS}steam/apps/7/abc/library_capsule.jpg?t=9");
        let mut facts = Facts { names: HashMap::from([(19, "Action".to_string())]), ..Default::default() };
        facts.apps.insert(7, AppFacts { at: now(), genres: vec![19], art: Art { cover: vec![hashed.clone()], ..Default::default() } });

        let mut xbox = Game::new("xbox", "Studio.Game", "Game", Launch::Uri { uri: String::new() });
        xbox.steam_app_id = Some(7);
        xbox.genres = vec!["Shooter".into()];
        facts.apply(&mut xbox);
        assert_eq!(xbox.art.cover, [hashed.clone()]);
        assert_eq!(xbox.genres, ["Shooter"], "its own store's genres stay");

        let mut steam = Game::new("steam", "7", "Game", Launch::Uri { uri: String::new() });
        steam.steam_app_id = Some(7);
        steam.genres = vec!["Shooter".into()];
        facts.apply(&mut steam);
        assert_eq!(steam.genres, ["Action"]);

        assert_eq!(facts.missing([7, 8, 8, 3]), [3, 8]);
    }

    #[test]
    fn builds_art_from_hashed_paths() {
        let item = json!({ "assets": { "asset_url_format": "steam/apps/7/${FILENAME}?t=9", "library_capsule": "abc/library_capsule.jpg", "header": "def/header.jpg" } });
        let art = art_of(&item);
        assert_eq!(art.cover, [format!("{ASSETS}steam/apps/7/abc/library_capsule.jpg?t=9")]);
        assert_eq!(art.hero, [format!("{ASSETS}steam/apps/7/def/header.jpg?t=9")]);
    }

    #[test]
    fn keeps_only_games_on_store_lists() {
        let no = HashMap::new();
        let names = HashMap::from([(19, "Action".to_string())]);
        let frame = json!({ "appid": 1, "name": "Steam Frame", "type": 10 });
        assert!(game_of(&frame, &no, &no_prices()).is_none());
        let game = json!({ "appid": 2, "name": "Game", "type": 0, "is_free": true, "tagids": [4231, 19] });
        let g = game_of(&game, &names, &no_prices()).unwrap();
        assert_eq!((g.id.as_str(), g.installed, g.price.as_deref()), ("steam:2", false, Some("Free")));
        assert_eq!(g.genres, ["Action"]);
        assert_eq!(g.tags, ["store"]);
    }

    #[test]
    fn prices_and_discounts_come_from_the_players_store() {
        let prices = HashMap::from([(2, ("7,49€".to_string(), 75)), (3, ("59,99€".to_string(), 0))]);
        let g = game_of(&json!({ "appid": 2, "name": "A" }), &HashMap::new(), &prices).unwrap();
        assert_eq!((g.price.as_deref(), g.discount), (Some("7,49€"), Some(75)));
        let g = game_of(&json!({ "appid": 3, "name": "B" }), &HashMap::new(), &prices).unwrap();
        assert_eq!((g.price.as_deref(), g.discount), (Some("59,99€"), None));
    }

    fn no_prices() -> HashMap<u32, (String, u8)> {
        HashMap::new()
    }
}
