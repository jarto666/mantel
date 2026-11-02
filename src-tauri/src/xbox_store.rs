//! The Microsoft Store's games to browse, from the public lists behind its website. Buying stays
//! in the Xbox app; a game on Game Pass or in the library takes its entry's place in the UI.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::Serialize;
use serde_json::Value;

use crate::art::{self, client, get_json};
use crate::gamepass;
use crate::model::{Game, Launch};

pub const ID_PREFIX: &str = "msstore:";

const UNREACHABLE: &str = "Couldn't reach the store";
const LISTS_URL: &str = "https://apps.microsoft.com/api/Reco/GetComputedProductsList";
/// The lists on the front page: our id, the shelf's title, the store's name for it.
const LISTS: &[(&str, &str, &str)] = &[("top", "Top sellers", "TopPaid"), ("popular", "Most popular", "MostPopular"), ("new", "New releases", "NewAndRising"), ("deals", "Deals", "Deal"), ("free", "Free games", "TopFree")];
const PAGE_SIZE: &str = "24";

/// Game pages looked up this run: the page and the trailer behind the list both ask.
static DETAILS: Mutex<Option<HashMap<String, Value>>> = Mutex::new(None);

#[derive(Debug, Serialize)]
pub struct Shelf {
    id: &'static str,
    title: &'static str,
    games: Vec<Game>,
}

#[derive(Debug, Serialize)]
pub struct Page {
    games: Vec<Game>,
    more: bool,
}

/// Product ids are letters and digits; anything else never reaches a link.
pub fn checked(product: &str) -> Result<&str, String> {
    (!product.is_empty() && product.chars().all(|c| c.is_ascii_alphanumeric())).then_some(product).ok_or_else(|| format!("Not a Store product: {product}"))
}

/// The digits of a price, which is enough to compare two in the same currency.
fn cents(price: &str) -> Option<f64> {
    let digits: String = price.chars().filter(char::is_ascii_digit).collect();
    digits.parse().ok().filter(|n| *n > 0.0)
}

/// What to show for the price. An unpriced game's text is "Free" or "Included" in the player's
/// language, or a release date that says nothing about what it costs.
fn price_of(item: &Value) -> Option<String> {
    let text = item.get("displayPrice")?.as_str()?.trim();
    let price = item.get("price").and_then(Value::as_f64).unwrap_or(0.0);
    (!text.is_empty() && (price > 0.0 || !text.chars().any(|c| c.is_ascii_digit()))).then(|| text.to_string())
}

fn discount_of(item: &Value) -> Option<u8> {
    let now = cents(item.get("displayPrice")?.as_str()?)?;
    let was = cents(item.get("strikethroughPrice")?.as_str()?)?;
    (was > now).then(|| ((1.0 - now / was) * 100.0).round() as u8).filter(|d| *d > 0)
}

fn game_of(item: &Value) -> Option<Game> {
    let id = item.get("productId")?.as_str()?.to_uppercase();
    let name = item.get("title")?.as_str()?.trim();
    let family = item.pointer("/packageFamilyNames/0").and_then(Value::as_str).unwrap_or_default();
    let image = |kind: &str, width: u32| {
        let list = item.get("images")?.as_array()?;
        let url = list.iter().find(|i| i.get("imageType").and_then(Value::as_str) == Some(kind))?.get("url")?.as_str()?;
        Some(format!("{url}?w={width}"))
    };
    let mut game = Game::new("xbox", family, name, Launch::Uri { uri: format!("{}{id}", gamepass::install_uri()) });
    game.id = format!("{ID_PREFIX}{id}");
    game.installed = false;
    game.art.cover.extend(image("Poster", 600).or_else(|| image("BoxArt", 600)));
    game.art.hero.extend(image("BoxArt", 1280).or_else(|| image("Poster", 1280)));
    game.tags = vec!["store".to_string()];
    game.genres = item.get("categories").and_then(Value::as_array).map(|a| a.iter().filter_map(|c| c.as_str().map(String::from)).collect()).unwrap_or_default();
    game.price = price_of(item);
    game.discount = discount_of(item);
    Some(game)
}

/// One page of a list, counting from 1, by the store's English name of a genre if given.
async fn fetch(list: &str, genre: Option<&str>, page: u32, language: &str) -> Result<Page, String> {
    let name = LISTS.iter().find(|(id, _, _)| *id == list).map_or("MostPopular", |(_, _, name)| name);
    let mut query = vec![("mediaType", "games".to_string()), ("listName", name.to_string()), ("noItems", PAGE_SIZE.to_string()), ("pgNo", page.to_string()), ("gl", gamepass::market(language)), ("hl", language.to_string())];
    if let Some(genre) = genre {
        query.push(("filteredCategories", genre.to_string()));
    }
    let answer = get_json(client().get(LISTS_URL).query(&query)).await.ok_or(UNREACHABLE)?;
    let items = answer.get("productsList").and_then(Value::as_array).ok_or(UNREACHABLE)?;
    Ok(Page { games: items.iter().filter_map(game_of).collect(), more: answer.get("hasMorePages").and_then(Value::as_bool).unwrap_or(false) })
}

pub async fn page(list: &str, genre: Option<&str>, page: u32, language: &str) -> Result<Page, String> {
    fetch(list, genre, page, language).await
}

/// The store's front page.
pub async fn home(language: &str) -> Result<Vec<Shelf>, String> {
    let pages = futures::future::join_all(LISTS.iter().map(|(id, _, _)| fetch(id, None, 1, language))).await;
    let shelves: Vec<Shelf> = LISTS.iter().zip(pages).filter_map(|((id, title, _), page)| Some(Shelf { id, title, games: page.ok()?.games })).filter(|s| !s.games.is_empty()).collect();
    if shelves.is_empty() {
        return Err(UNREACHABLE.into());
    }
    Ok(shelves)
}

/// A game's page, built like a Game Pass game's. Not kept past this run: browsing shouldn't grow
/// the cache, and prices move.
pub async fn details(product: &str, language: &str, sgdb_key: &str) -> Option<Value> {
    if let Some(known) = DETAILS.lock().unwrap().as_ref().and_then(|d| d.get(product)) {
        return Some(known.clone());
    }
    let (name, hero, mut d) = gamepass::product_details(product, language).await?;
    let (trailer, logo) = futures::join!(gamepass::pick_trailer(&d, &name), art::find_logo(&name, sgdb_key));
    d["videos"] = gamepass::playable_videos(&d, trailer.as_deref(), hero.as_deref()).await.into();
    d["trailer"] = trailer.into();
    d["logo"] = logo.into();
    DETAILS.lock().unwrap().get_or_insert_with(HashMap::new).insert(product.to_string(), d.clone());
    Some(d)
}

/// A way to buy a game, for the list of its editions.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Edition {
    id: String,
    title: String,
    /// Not sold in this market when empty.
    price: Option<f64>,
    was: Option<f64>,
    currency: Option<String>,
    /// The products inside a bundle: having all of them is as good as having the bundle.
    parts: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Editions {
    /// The product with the files, which is what installs: many editions have none of their own.
    game: String,
    pfn: String,
    title: String,
    editions: Vec<Edition>,
}

fn product_id(p: &Value) -> &str {
    p.get("ProductId").and_then(Value::as_str).unwrap_or_default()
}

/// What a full SKU costs to buy here, if it's for sale: list price, usual price, currency.
fn offer(p: &Value) -> Option<(f64, f64, String)> {
    let skus = p.get("DisplaySkuAvailabilities")?.as_array()?;
    skus.iter().filter(|s| s.pointer("/Sku/SkuType").and_then(Value::as_str) == Some("full")).find_map(|s| {
        let on_sale = s.get("Availabilities")?.as_array()?.iter().find(|a| a.get("Actions").and_then(Value::as_array).is_some_and(|l| l.iter().any(|x| x.as_str() == Some("Purchase"))))?;
        let price = on_sale.pointer("/OrderManagementData/Price")?;
        let list = price.get("ListPrice")?.as_f64()?;
        Some((list, price.get("MSRP").and_then(Value::as_f64).unwrap_or(list), price.get("CurrencyCode")?.as_str()?.to_string()))
    })
}

fn parts_of(p: &Value) -> Vec<String> {
    let mut parts = Vec::new();
    for sku in p.get("DisplaySkuAvailabilities").and_then(Value::as_array).into_iter().flatten() {
        for part in sku.pointer("/Sku/Properties/BundledSkus").and_then(Value::as_array).into_iter().flatten() {
            let id = part.get("BigId").and_then(Value::as_str).unwrap_or_default().to_string();
            if !id.is_empty() && !parts.contains(&id) {
                parts.push(id);
            }
        }
    }
    parts
}

fn installs_on_pc(p: &Value) -> bool {
    p.get("ProductKind").and_then(Value::as_str) == Some("Game") && gamepass::all_packages(p).into_iter().any(gamepass::for_pc)
}

fn related(p: &Value, relation: &str) -> Vec<String> {
    let list = p.pointer("/MarketProperties/0/RelatedProducts").and_then(Value::as_array);
    list.into_iter().flatten().filter(|r| r.get("RelationshipType").and_then(Value::as_str) == Some(relation)).filter_map(|r| r.get("RelatedProductId")?.as_str().map(String::from)).collect()
}

fn edition_of(p: &Value) -> Edition {
    let (price, was, currency) = offer(p).map_or((None, None, None), |(price, was, currency)| (Some(price), Some(was), Some(currency)));
    Edition { id: product_id(p).to_string(), title: gamepass::product_title(p), price, was, currency, parts: parts_of(p) }
}

/// From the game with the files, the editions on sale here: the store also relates pre-order keys
/// and console bundles to it, which have no price. The game itself is listed only when it's sold
/// on its own, or nothing else is.
fn editions_from(game: &Value, card: &Value, others: &[Value]) -> Editions {
    let id = product_id(game);
    let mut editions = Vec::new();
    for p in std::iter::once(game).chain(std::iter::once(card)).chain(others) {
        let sold = offer(p).is_some();
        let holds_game = product_id(p) == id || parts_of(p).iter().any(|part| part == id);
        if sold && holds_game && !editions.iter().any(|e: &Edition| e.id == product_id(p)) {
            editions.push(edition_of(p));
        }
    }
    if editions.is_empty() {
        editions.push(edition_of(game));
    }
    let pfn = gamepass::all_packages(game).into_iter().filter(|x| gamepass::for_pc(x)).find_map(|x| x.get("PackageFamilyName")?.as_str().filter(|n| !n.is_empty()));
    Editions { game: id.to_string(), pfn: pfn.unwrap_or_default().to_string(), title: gamepass::product_title(game), editions }
}

/// A game's editions, from any card of it. Nothing when it can't install on a PC from here, as
/// with console-only entries and games sold through a publisher's launcher.
pub async fn editions(product: &str, language: &str) -> Option<Editions> {
    let http = client();
    let market = gamepass::market(language);
    let card = gamepass::products(&http, &[product.to_string()], &market, language).await.into_iter().next()?;
    let game = if installs_on_pc(&card) {
        card.clone()
    } else {
        gamepass::products(&http, &parts_of(&card), &market, language).await.into_iter().find(installs_on_pc)?
    };
    let others = gamepass::products(&http, &related(&game, "Bundle"), &market, language).await;
    Some(editions_from(&game, &card, &others))
}

/// The store's games by name. Its autosuggest is the accurate search: the one behind the store's
/// website fills up with whatever else is popular.
pub async fn search(query: &str, language: &str) -> Result<Vec<SearchHit>, String> {
    let http = client();
    let market = gamepass::market(language);
    let req = http.get("https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest").query(&[("market", market.as_str()), ("languages", language), ("query", query), ("productFamilyNames", "Games")]);
    let answer = get_json(req).await.ok_or(UNREACHABLE)?;
    let found = answer.pointer("/Results/0/Products").and_then(Value::as_array).cloned().unwrap_or_default();
    let ids: Vec<String> = found.iter().filter(|p| p.get("Type").and_then(Value::as_str) == Some("Game")).filter_map(|p| p.get("ProductId")?.as_str().map(String::from)).collect();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let products = gamepass::products(&http, &ids, &market, language).await;
    Ok(ids.iter().filter_map(|id| products.iter().find(|p| product_id(p) == id)).filter_map(|p| hit_of(p)).collect())
}

/// A store entry and its price as a number: only the page can write it in the player's format.
#[derive(Debug, Serialize)]
pub struct SearchHit {
    game: Game,
    price: Option<f64>,
    was: Option<f64>,
    currency: Option<String>,
}

fn hit_of(p: &Value) -> Option<SearchHit> {
    let (mut game, _) = gamepass::parse(p, gamepass::install_uri())?;
    game.id = format!("{ID_PREFIX}{}", product_id(p));
    game.tags = vec!["store".to_string()];
    let (price, was, currency) = offer(p).map_or((None, None, None), |(price, was, currency)| (Some(price), Some(was), Some(currency)));
    Some(SearchHit { game, price, was, currency })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn checks_product_ids() {
        assert!(checked("9NXFX68ZNKK0").is_ok());
        assert!(checked("9NX'; calc").is_err());
        assert!(checked("").is_err());
    }

    #[test]
    fn reads_a_priced_game() {
        let item = json!({ "productId": "9p6zxp2zrqcv", "title": "GTA V", "price": 20.68, "displayPrice": "20,68 €", "strikethroughPrice": "45,96 €", "categories": ["Action & adventure"],
            "images": [{ "imageType": "Poster", "url": "https://img/p" }, { "imageType": "BoxArt", "url": "https://img/b" }] });
        let g = game_of(&item).unwrap();
        assert_eq!((g.id.as_str(), g.installed, g.price.as_deref(), g.discount), ("msstore:9P6ZXP2ZRQCV", false, Some("20,68 €"), Some(55)));
        assert_eq!(g.art.cover, ["https://img/p?w=600"]);
        assert_eq!(g.tags, ["store"]);
    }

    #[test]
    fn says_nothing_for_a_release_date_in_place_of_a_price() {
        assert_eq!(price_of(&json!({ "price": 0, "displayPrice": "Available on 11/9/2021" })), None);
        assert_eq!(price_of(&json!({ "price": 0, "displayPrice": "Бесплатно" })).as_deref(), Some("Бесплатно"));
        assert_eq!(price_of(&json!({ "price": 0, "displayPrice": "Included", "plaintextPassName": "Xbox Game Pass" })).as_deref(), Some("Included"));
    }

    fn product(id: &str, kind: &str, price: Option<f64>, parts: &[&str], platform: Option<&str>) -> Value {
        let actions = if price.is_some() { json!(["Details", "Purchase"]) } else { json!(["Details"]) };
        let packages = platform.map_or(json!(null), |p| json!([{ "PackageFamilyName": "Studio.Game_abc", "PlatformDependencies": [{ "PlatformName": p }] }]));
        json!({ "ProductId": id, "ProductKind": kind, "LocalizedProperties": [{ "ProductTitle": id }], "DisplaySkuAvailabilities": [{
            "Sku": { "SkuType": "full", "Properties": { "Packages": packages, "BundledSkus": parts.iter().map(|b| json!({ "BigId": b })).collect::<Vec<_>>() } },
            "Availabilities": [{ "Actions": actions, "OrderManagementData": { "Price": { "ListPrice": price.unwrap_or(0.0), "MSRP": price.unwrap_or(0.0), "CurrencyCode": "USD" } } }],
        }] })
    }

    #[test]
    fn lists_the_editions_on_sale_with_the_game_that_installs() {
        let game = product("BASE", "Game", Some(17.99), &[], Some("Windows.Desktop"));
        let ultimate = product("ULTIMATE", "Game", Some(31.99), &["BASE", "DLC"], None);
        let key = product("KEY", "Game", None, &["BASE"], None);
        let found = editions_from(&game, &ultimate, &[ultimate.clone(), key]);
        assert_eq!((found.game.as_str(), found.pfn.as_str()), ("BASE", "Studio.Game_abc"));
        assert_eq!(found.editions.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["BASE", "ULTIMATE"]);
        assert_eq!(found.editions[1].parts, ["BASE", "DLC"]);
    }

    #[test]
    fn leaves_out_a_game_not_sold_alone_unless_nothing_else_is() {
        let game = product("BASE", "Game", None, &[], Some("Windows.Desktop"));
        let standard = product("STANDARD", "Game", Some(59.99), &["BASE"], None);
        assert_eq!(editions_from(&game, &standard, &[]).editions.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["STANDARD"]);
        assert_eq!(editions_from(&game, &game, &[]).editions.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["BASE"]);
    }

    #[test]
    fn console_packages_dont_install_on_a_pc() {
        assert!(!installs_on_pc(&product("BASE", "Game", None, &[], Some("Windows.Xbox"))));
        assert!(installs_on_pc(&product("BASE", "Game", None, &[], Some("Windows.Desktop"))));
        assert!(!installs_on_pc(&product("BUNDLE", "Game", None, &["BASE"], None)));
    }

    #[test]
    fn a_blank_strikethrough_is_no_discount() {
        assert_eq!(discount_of(&json!({ "displayPrice": "Included", "strikethroughPrice": "\u{200b}" })), None);
        assert_eq!(discount_of(&json!({ "displayPrice": "30,62 €", "strikethroughPrice": null })), None);
    }
}
