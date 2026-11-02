//! The PC Game Pass catalog, from the same public Microsoft services the Xbox app reads, for
//! browsing and installing games that aren't on this PC yet. No sign-in needed.

use std::collections::HashMap;
use std::time::Duration;

use futures::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::model::{now, Game, Launch};

/// Microsoft's lists for PC Game Pass, as the Xbox app shows them. "All" includes EA Play.
const ALL: &str = "609d944c-d395-4c0a-9ea4-e9f39b52c1ad";
const RECENT: &str = "3fdd7f57-7092-4b65-bd40-5a9dac1b2b84";
const LEAVING: &str = "393f05bf-e596-4ef6-9487-6d4fa0eab987";
const POPULAR: &str = "a884932a-f02b-40c8-a903-a008c23b1df1";
const EA_PLAY: &str = "1d33fbb9-b895-4732-a8ca-a55c8b99fa2c";
/// Products per catalog request; the URL stays short and requests run side by side.
const BATCH: usize = 20;
/// The catalog changes a few times a month.
pub const FRESH_SECS: i64 = 24 * 3600;
/// Bumped when a cached catalog lacks something newer code reads (tags, genres).
pub const FORMAT: u32 = 8;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Catalog {
    pub format: u32,
    pub at: i64,
    pub language: String,
    pub games: Vec<Game>,
    /// Game page details by game id, shaped like Steam's (see `art::steam_details`).
    pub details: HashMap<String, Value>,
}

/// Catalog attributes a player on PC cares about, as labels the interface translates.
const FEATURES: &[(&str, &str)] = &[
    ("SinglePlayer", "Single player"),
    ("XblOnlineCoop", "Online co-op"),
    ("CoopSupportOnline", "Online co-op"),
    ("XblLocalCoop", "Local co-op"),
    ("CoopSupportLocal", "Local co-op"),
    ("XblOnlineMultiPlayer", "Online multiplayer"),
    ("OnlineMultiplayerWithGold", "Online multiplayer"),
    ("XblLocalMultiPlayer", "Local multiplayer"),
    ("LocalMultiplayer", "Local multiplayer"),
    ("SharedSplitScreen", "Split screen"),
    ("XblCrossPlatformMultiPlayer", "Cross-platform"),
    ("XblCrossPlatformCoop", "Cross-platform"),
    ("CrossPlatformMultiPlayer", "Cross-platform"),
    ("CrossPlatformCoOp", "Cross-platform"),
    ("PcGamePad", "Controller support"),
    ("XblCloudSaves", "Cloud saves"),
    ("XblAchievements", "Achievements"),
    ("XPA", "Play Anywhere"),
];

/// Below this a package size is a stub's: the real download only shows once it starts.
const TRUSTED_SIZE: u64 = 100 * 1024 * 1024;

/// Game ids in the catalog start with this, so they never collide with library games.
pub const ID_PREFIX: &str = "gamepass:";

/// Where the player is, for the store: Windows' region, else what the language says.
pub fn market(language: &str) -> String {
    windows_region().or_else(|| language.split('-').nth(1).map(str::to_uppercase)).unwrap_or_else(|| "US".into())
}

/// One product's page, as for a catalog game, with its name and hero art.
pub async fn product_details(product: &str, language: &str) -> Option<(String, Option<String>, Value)> {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).user_agent("Mantel (game launcher)").build().ok()?;
    let found = products(&http, &[product.to_string()], &market(language), language).await;
    let (game, details) = parse(found.first()?, install_uri())?;
    Some((game.name, game.art.hero.first().cloned(), details))
}

pub async fn fetch(language: &str) -> Result<Catalog, String> {
    // Where the player is decides what's included, so the market is Windows' region, not
    // the language's: a Russian interface in Germany shows the German catalog, in Russian.
    let market = market(language);
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Mantel (game launcher)")
        .build()
        .map_err(|e| e.to_string())?;

    let list = |id: &'static str| {
        let req = http.get("https://catalog.gamepass.com/sigls/v2").query(&[("id", id), ("language", language), ("market", &market)]);
        async move {
            let list: Vec<Value> = req.send().await.ok()?.json().await.ok()?;
            // The first entry describes the list itself.
            Some(list.iter().filter_map(|v| v.get("id")?.as_str().map(String::from)).collect::<Vec<_>>())
        }
    };
    let (all, recent, leaving, popular, ea) = futures::join!(list(ALL), list(RECENT), list(LEAVING), list(POPULAR), list(EA_PLAY));
    let all = all.filter(|l| !l.is_empty()).ok_or("The Game Pass catalog couldn't be loaded")?;
    let (recent, leaving, popular, ea) = (recent.unwrap_or_default(), leaving.unwrap_or_default(), popular.unwrap_or_default(), ea.unwrap_or_default());
    let ids = all;

    let install = install_uri();
    let listed = products(&http, &ids, &market, language).await;

    let mut catalog = Catalog { format: FORMAT, at: now(), language: language.to_string(), ..Default::default() };
    for p in &listed {
        let Some((mut game, details)) = parse(p, &install) else { continue };
        let product = &game.id[ID_PREFIX.len()..];
        for (tag, list) in [("new", &recent), ("leaving", &leaving), ("popular", &popular), ("eaplay", &ea)] {
            if list.iter().any(|r| r == product) {
                game.tags.push(tag.into());
            }
        }
        catalog.details.insert(game.id.clone(), details);
        catalog.games.push(game);
    }
    let mut packages: Vec<String> = catalog.details.values().flat_map(bundled).collect();
    packages.sort();
    packages.dedup();
    let packages: HashMap<String, Value> =
        products(&http, &packages, &market, language).await.into_iter().filter_map(|p| Some((p.get("ProductId")?.as_str()?.to_string(), p))).collect();
    for game in &mut catalog.games {
        if let Some(details) = catalog.details.get_mut(&game.id) {
            complete_bundle(game, details, &packages);
        }
    }
    // What's new and what's about to go first, then the biggest hits, then everything by name.
    let rank = |g: &Game| {
        let product = &g.id[ID_PREFIX.len()..];
        let at = |list: &[String]| list.iter().position(|r| r == product);
        at(&recent)
            .map(|i| (0, i))
            .or_else(|| at(&leaving).map(|i| (1, i)))
            .or_else(|| at(&popular).map(|i| (2, i)))
            .unwrap_or((3, 0))
    };
    catalog.games.sort_by_cached_key(|g| (rank(g), crate::library::sort_key(&g.name)));
    crate::log::info(&format!("game pass: {} of {} games for {market}", catalog.games.len(), ids.len()));
    Ok(catalog)
}

pub(crate) async fn products(http: &reqwest::Client, ids: &[String], market: &str, language: &str) -> Vec<Value> {
    // Owned strings: a stream over borrowed chunks makes the command's future not Send.
    let batches: Vec<String> = ids.chunks(BATCH).map(|c| c.join(",")).collect();
    let (market, language) = (market.to_string(), language.to_string());
    let batches: Vec<Option<Vec<Value>>> = stream::iter(batches)
        .map(|batch| {
            let req = http
                .get("https://displaycatalog.mp.microsoft.com/v7.0/products")
                .query(&[("bigIds", batch.as_str()), ("market", &market), ("languages", &language)]);
            async move {
                let v: Value = req.send().await.ok()?.json().await.ok()?;
                v.get("Products")?.as_array().cloned()
            }
        })
        .buffered(6)
        .collect()
        .await;
    batches.into_iter().flatten().flatten().collect()
}

fn features(p: &Value) -> Vec<&'static str> {
    let empty = Vec::new();
    let attributes = p.pointer("/Properties/Attributes").and_then(Value::as_array).unwrap_or(&empty);
    let on_pc = |a: &&Value| a.get("ApplicablePlatforms").and_then(Value::as_array).is_none_or(|list| list.iter().any(|x| x == "Desktop"));
    let names: Vec<&str> = attributes.iter().filter(on_pc).filter_map(|a| a.get("Name")?.as_str()).collect();
    let mut labels: Vec<&'static str> = FEATURES.iter().filter(|(name, _)| names.contains(name)).map(|(_, label)| *label).collect();
    labels.dedup();
    labels
}

fn bundled(details: &Value) -> Vec<String> {
    details.get("bundled").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(String::from).collect()
}

pub(crate) fn product_title(p: &Value) -> String {
    p.pointer("/LocalizedProperties/0/ProductTitle").and_then(Value::as_str).unwrap_or_default().trim().to_string()
}

/// A product's packages, across its SKUs.
pub(crate) fn all_packages(p: &Value) -> Vec<&Value> {
    let skus = p.get("DisplaySkuAvailabilities").and_then(Value::as_array).into_iter().flatten();
    skus.filter_map(|s| s.pointer("/Sku/Properties/Packages").and_then(Value::as_array)).flatten().collect()
}

/// Many products list their console packages next to the PC ones, often first.
pub(crate) fn for_pc(package: &Value) -> bool {
    let platforms = package.get("PlatformDependencies").and_then(Value::as_array);
    platforms.is_none_or(|list| list.is_empty() || list.iter().any(|d| d.get("PlatformName").and_then(Value::as_str) != Some("Windows.Xbox")))
}

fn package_size(p: &Value) -> u64 {
    all_packages(p).into_iter().filter(|x| for_pc(x)).find_map(|x| x.get("MaxDownloadSizeInBytes").and_then(Value::as_u64)).unwrap_or(0)
}

/// A bundle's listing leaves out what its products have: genres, package name, size. It also
/// says what could be left out of the install: "items", when there's anything to choose. Each
/// is the "main" game, its "launcher" (both required), another "game", or an "addon".
fn complete_bundle(game: &mut Game, details: &mut Value, packages: &HashMap<String, Value>) {
    let ids = bundled(details);
    if ids.is_empty() {
        return;
    }
    let primary = details.get("primary").and_then(Value::as_str).map(String::from);
    let is_game = |p: &Value| p.get("ProductKind").and_then(Value::as_str) == Some("Game");
    let is_launcher = |p: &Value| product_title(p).to_lowercase().contains("launcher");
    let games: Vec<&String> = ids.iter().filter(|id| packages.get(*id).is_some_and(|p| is_game(p) && !is_launcher(p))).collect();
    // No flag on any of them: a lone game is still the main one, several are a real choice.
    let main = primary.or_else(|| (games.len() == 1).then(|| games[0].clone()));

    if let Some(p) = main.as_ref().or(games.first().copied()).and_then(|id| packages.get(id)) {
        if game.source_id.is_empty() {
            game.source_id = p.pointer("/Properties/PackageFamilyName").and_then(Value::as_str).unwrap_or_default().to_string();
        }
        let genres = p.pointer("/Properties/Categories").filter(|c| c.is_array()).cloned().unwrap_or(json!([]));
        game.genres = genres.as_array().map(|a| a.iter().filter_map(|g| g.as_str().map(String::from)).collect()).unwrap_or_default();
        details["genres"] = genres;
        if details.get("features").and_then(Value::as_array).is_none_or(Vec::is_empty) {
            details["features"] = json!(features(p));
        }
    }
    let size: u64 = ids.iter().filter_map(|id| packages.get(id)).map(package_size).sum();
    game.size_bytes = game.size_bytes.or((size >= TRUSTED_SIZE).then_some(size));

    let items: Vec<Value> = ids
        .iter()
        .filter_map(|id| {
            let p = packages.get(id)?;
            let kind = if main.as_ref() == Some(id) {
                "main"
            } else if is_launcher(p) {
                "launcher"
            } else if is_game(p) {
                "game"
            } else {
                "addon"
            };
            let size = package_size(p);
            Some(json!({ "id": id, "title": product_title(p), "kind": kind, "size": (size >= TRUSTED_SIZE).then_some(size) }))
        })
        .collect();
    if items.iter().any(|i| i["kind"] == "game" || i["kind"] == "addon") {
        details["items"] = items.into();
    }
}

/// Whether a catalog game is on its way, going by what Windows is installing. Bundles share
/// packages like launchers, so it's the game's own packages that say.
pub fn is_under_way(catalog: &Catalog, product: &str, busy: &[String]) -> bool {
    let items = catalog.details.get(&format!("{ID_PREFIX}{product}")).and_then(|d| d.get("items")).and_then(Value::as_array);
    match items {
        Some(items) => items.iter().filter(|i| i["kind"] == "main" || i["kind"] == "game").filter_map(|i| i["id"].as_str()).any(|id| busy.iter().any(|b| b == id)),
        None => packages(catalog, product).iter().all(|p| busy.contains(p)),
    }
}

pub(crate) fn parse(p: &Value, install: &str) -> Option<(Game, Value)> {
    let id = p.get("ProductId")?.as_str()?;
    let lp = p.get("LocalizedProperties")?.get(0)?;
    let name = lp.get("ProductTitle")?.as_str()?.trim();
    // Editions and bundles name their package only on the SKU. Matched against installed games.
    let pfn = p
        .get("Properties")
        .and_then(|x| x.get("PackageFamilyName"))
        .or_else(|| p.pointer("/DisplaySkuAvailabilities/0/Sku/Properties/Packages/0/PackageFamilyName"))
        .and_then(Value::as_str)
        .unwrap_or_default();
    let images: Vec<(&str, String)> = lp
        .get("Images")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|i| Some((i.get("ImagePurpose")?.as_str()?, format!("https:{}", i.get("Uri")?.as_str()?))))
                .collect()
        })
        .unwrap_or_default();
    // The store resizes on request: full-size posters and hero art run to several megabytes.
    let image = |purpose: &str, width: u32| images.iter().find(|(p, _)| *p == purpose).map(|(_, u)| format!("{u}?w={width}"));

    let mut game = Game::new("xbox", pfn, name, Launch::Uri { uri: format!("{install}{id}") });
    game.id = format!("{ID_PREFIX}{id}");
    game.installed = false;
    game.size_bytes = Some(package_size(p)).filter(|n| *n > 0);
    game.art.cover.extend(image("Poster", 600).or_else(|| image("BoxArt", 600)));
    game.art.hero.extend(image("SuperHeroArt", 1920).or_else(|| image("TitledHeroArt", 1920)));

    let screenshots: Vec<String> =
        images.iter().filter(|(p, _)| *p == "Screenshot").map(|(_, u)| format!("{u}?w=1920")).fold(Vec::new(), |mut v, u| {
            // Each screenshot is listed twice.
            if !v.contains(&u) {
                v.push(u);
            }
            v
        });
    let text = |key: &str| lp.get(key).and_then(Value::as_str).filter(|s| !s.is_empty());
    let genres = p.get("Properties").and_then(|x| x.get("Categories")).filter(|c| c.is_array()).cloned().unwrap_or(json!([]));
    game.genres = genres.as_array().map(|a| a.iter().filter_map(|g| g.as_str().map(String::from)).collect()).unwrap_or_default();
    let released = p.get("MarketProperties").and_then(|m| m.get(0)).and_then(|m| m.get("OriginalReleaseDate")).and_then(Value::as_str).and_then(release_date);
    // Trailers as DASH, the hero trailer first. Which one plays is settled when the page opens
    // (see `pick_trailer`): one of Microsoft's CDNs turns some regions away.
    let mut videos: Vec<&Value> = lp.get("CMSVideos").and_then(Value::as_array).map(|v| v.iter().collect()).unwrap_or_default();
    videos.sort_by_key(|v| v.get("VideoPurpose").and_then(Value::as_str) != Some("HeroTrailer"));
    let trailers: Vec<&str> = videos.iter().filter_map(|v| v.get("DASH")?.as_str()).collect();
    let videos: Vec<Value> = videos
        .iter()
        .filter_map(|v| {
            let thumb = v.pointer("/PreviewImage/Uri").and_then(Value::as_str).map(|u| format!("https:{}?w=640", u.trim_start_matches("https:")));
            Some(json!({ "url": v.get("DASH")?.as_str()?, "thumb": thumb, "title": v.get("Caption") }))
        })
        .take(6)
        .collect();
    // A bundle's listing isn't what Windows installs: it installs these products, under their ids.
    let bundled: Vec<&str> = p
        .pointer("/DisplaySkuAvailabilities/0/Sku/Properties/BundledSkus")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|b| b.get("BigId")?.as_str()).collect())
        .unwrap_or_default();
    // Neither packages nor a bundle: installed through the publisher's launcher, which Windows'
    // installer can't do. The Xbox app can.
    let packages = all_packages(p);
    // Packages for consoles alone: the catalog lists these too, and a PC can't play them.
    if !packages.is_empty() && !packages.iter().any(|x| for_pc(x)) && bundled.is_empty() {
        return None;
    }
    if packages.is_empty() && bundled.is_empty() {
        game.tags.push("external".into());
    }
    let primary = p
        .pointer("/DisplaySkuAvailabilities/0/Sku/Properties/BundledSkus")
        .and_then(Value::as_array)
        .and_then(|list| list.iter().find(|b| b.get("IsPrimary").and_then(Value::as_bool) == Some(true)))
        .and_then(|b| b.get("BigId"));
    let details = json!({
        "bundled": bundled,
        "primary": primary,
        "features": features(p),
        "videos": videos,
        "trailers": trailers,
        "description": text("ShortDescription").or_else(|| text("Description")),
        "genres": genres,
        "developers": text("DeveloperName").map(|d| vec![d]),
        "publishers": text("PublisherName").map(|d| vec![d]),
        "releaseDate": released,
        "screenshots": screenshots.into_iter().take(10).collect::<Vec<_>>(),
    });
    Some((game, details))
}

/// What Windows installs for a catalog product: the bundle's products, or the product itself.
pub fn packages(catalog: &Catalog, product: &str) -> Vec<String> {
    let bundled = catalog.details.get(&format!("{ID_PREFIX}{product}")).and_then(|d| d.get("bundled")).and_then(Value::as_array);
    let list: Vec<String> = bundled.into_iter().flatten().filter_map(Value::as_str).map(String::from).collect();
    if list.is_empty() {
        vec![product.to_string()]
    } else {
        list
    }
}

/// The videos this PC can load, for the page's media rail; Steam's trailer when none of
/// Microsoft's can be.
pub async fn playable_videos(details: &Value, trailer: Option<&str>, thumb: Option<&str>) -> Vec<Value> {
    let http = crate::art::client();
    let mut playable = Vec::new();
    for video in details.get("videos").and_then(Value::as_array).into_iter().flatten() {
        if let Some(url) = video.get("url").and_then(Value::as_str) {
            if reachable(&http, url).await {
                playable.push(video.clone());
            }
        }
    }
    if playable.is_empty() {
        playable.extend(trailer.map(|url| json!({ "url": url, "thumb": thumb, "title": null })));
    }
    playable
}

/// The first trailer this PC can load, or failing that the game's Steam trailer, found by name.
pub async fn pick_trailer(details: &Value, name: &str) -> Option<String> {
    let http = crate::art::client();
    for url in details.get("trailers").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        if reachable(&http, url).await {
            return Some(url.to_string());
        }
    }
    let appid = crate::art::steam_exact(&http, name).await?;
    crate::art::steam_details(appid, "english").await?.get("trailer")?.as_str().map(String::from)
}

/// Whether a trailer's host answers here, asked once per host and run.
async fn reachable(http: &reqwest::Client, url: &str) -> bool {
    static HOSTS: std::sync::Mutex<Vec<(String, bool)>> = std::sync::Mutex::new(Vec::new());
    let host = reqwest::Url::parse(url).ok().and_then(|u| u.host_str().map(String::from)).unwrap_or_default();
    if let Some(&(_, ok)) = HOSTS.lock().unwrap().iter().find(|(h, _)| *h == host) {
        return ok;
    }
    let ok = http.get(url).send().await.is_ok_and(|r| r.status().is_success());
    if !ok {
        crate::log::info(&format!("game pass: trailers from {host} don't load here"));
    }
    HOSTS.lock().unwrap().push((host, ok));
    ok
}

/// `2025-11-04T16:00:00.0000000Z` → `Nov 4, 2025`, the way Steam writes dates. Placeholder
/// dates far in the past or future mean "unknown".
fn release_date(iso: &str) -> Option<String> {
    const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    let mut parts = iso.get(..10)?.split('-').map(|x| x.parse::<usize>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    if !(1980..2100).contains(&y) {
        return None;
    }
    Some(format!("{} {d}, {y}", MONTHS.get(m.checked_sub(1)?)?))
}

/// The two-letter region set in Windows (Settings → Time & language → Region).
#[cfg(windows)]
fn windows_region() -> Option<String> {
    let name = crate::library::reg::hkcu_str(r"Control Panel\International\Geo", "Name")?;
    (name.len() == 2).then(|| name.to_uppercase())
}

#[cfg(not(windows))]
fn windows_region() -> Option<String> {
    None
}

/// The Xbox app's page for a game when it's installed, which is where Game Pass installs
/// happen; otherwise the Microsoft Store's.
pub fn install_uri() -> &'static str {
    #[cfg(windows)]
    {
        use winreg::{enums::HKEY_CLASSES_ROOT, RegKey};
        if RegKey::predef(HKEY_CLASSES_ROOT).open_subkey("msxbox").is_ok() {
            return "msxbox://game/?productId=";
        }
    }
    "ms-windows-store://pdp/?ProductId="
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_release_dates() {
        assert_eq!(release_date("2025-11-04T16:00:00.0000000Z").as_deref(), Some("Nov 4, 2025"));
        assert_eq!(release_date("1753-01-01T00:00:00.0000000Z"), None);
        assert_eq!(release_date("2025-13-01T00:00:00Z"), None);
    }
}
