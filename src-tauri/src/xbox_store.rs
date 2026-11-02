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

    #[test]
    fn a_blank_strikethrough_is_no_discount() {
        assert_eq!(discount_of(&json!({ "displayPrice": "Included", "strikethroughPrice": "\u{200b}" })), None);
        assert_eq!(discount_of(&json!({ "displayPrice": "30,62 €", "strikethroughPrice": null })), None);
    }
}
