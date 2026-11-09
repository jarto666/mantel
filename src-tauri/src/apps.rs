//! Programs and sites on the Apps tab: music, video, chat, browsers. They come from the Start
//! menu (programs, Microsoft Store apps, sites a browser installed as apps), or are sites that
//! open in an Edge window of their own. Known media and chat apps join the tab by themselves.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::model::{Game, Launch};

/// An app on the Apps tab, or one to offer for it.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct AppEntry {
    pub name: String,
    /// "store", "desktop", "web" (a site a browser installed as an app), "site", or "file" for
    /// one picked from the file system.
    pub kind: String,
    /// What launches it: a Start menu app id, the site's address, or the file's path.
    pub target: String,
    /// The program a desktop app runs, which is what shows up as its process.
    pub exe: Option<String>,
    /// A Microsoft Store app's install folder.
    pub location: Option<String>,
    /// A picture of its icon on disk.
    pub icon: Option<String>,
    /// Its tile colour, when the app names one.
    pub color: Option<String>,
}

impl AppEntry {
    /// Stable across scans and renames: the same app id always gives the same library id.
    pub fn id(&self) -> String {
        format!("{:016x}", fnv(&self.target.to_lowercase()))
    }
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ b as u64).wrapping_mul(0x100_0000_01b3))
}

/// Sites offered as apps. Each opens in an Edge window without the address bar.
pub const SITES: &[(&str, &str)] = &[
    ("YouTube", "https://www.youtube.com"),
    ("YouTube Music", "https://music.youtube.com"),
    ("Twitch", "https://www.twitch.tv"),
    ("Xbox Cloud Gaming", "https://www.xbox.com/play"),
    ("GeForce NOW", "https://play.geforcenow.com"),
];

/// Apps that join the Apps tab by themselves once installed: the Store and Edge, as a start
/// anyone can take off, and media, streaming and chat apps.
const KNOWN: &[&str] = &[
    "microsoft store", "microsoft edge", "spotify", "discord", "netflix", "disney+", "prime video", "plex", "plex htpc", "kodi", "vlc media player", "moonlight",
    "steam link", "parsec", "youtube", "youtube music", "twitch", "crunchyroll", "apple tv", "apple music", "whatsapp",
    "telegram desktop",
];

pub fn is_known(name: &str) -> bool {
    let name = name.trim().to_lowercase();
    KNOWN.iter().any(|k| name == *k || name.starts_with(&format!("{k} ")))
}

/// Start menu entries that aren't apps someone would open from a couch.
const JUNK: &[&str] = &[
    "uninstall", "readme", "read me", "help", "manual", "website", "support", "update", "setup", "config", "release notes",
    "license", "documentation", "changelog", "feedback", "redist", "crash", "report", "debug",
];

/// One entry of the Start menu, as the PowerShell query reports it.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StartApp {
    pub name: String,
    pub app_id: String,
    /// A Store app's install folder.
    pub location: Option<String>,
    /// For a shortcut: where it points, its arguments and its icon ("path,index").
    pub target: Option<String>,
    pub args: Option<String>,
    pub icon: Option<String>,
}

/// What kind of app a Start menu entry is, or None for one that isn't worth offering.
pub fn classify(s: &StartApp) -> Option<AppEntry> {
    let lower = s.name.to_lowercase();
    if s.name.trim().is_empty() || s.app_id.is_empty() || JUNK.iter().any(|j| lower.contains(j)) {
        return None;
    }
    let target = s.target.as_deref().filter(|t| !t.is_empty());
    let browser_app = target.is_some_and(|t| {
        let t = t.to_lowercase();
        t.ends_with("_proxy.exe") || t.ends_with("\\pwahelper.exe")
    }) || s.args.as_deref().is_some_and(|a| a.contains("--app-id"));
    let mut entry = AppEntry { name: s.name.trim().to_string(), target: s.app_id.clone(), ..Default::default() };
    if s.app_id.contains('!') && s.location.is_some() {
        entry.kind = "store".into();
        entry.location = s.location.clone();
    } else if browser_app {
        entry.kind = "web".into();
    } else if let Some(exe) = target.filter(|t| t.to_lowercase().ends_with(".exe")) {
        if exe.to_lowercase().starts_with(r"c:\windows") {
            return None;
        }
        entry.kind = "desktop".into();
        entry.exe = Some(exe.to_string());
    } else {
        return None;
    }
    Some(entry)
}

/// Where its icon comes from: the shortcut's own icon, or the program it runs.
pub fn icon_source(s: &StartApp) -> Option<(String, i32)> {
    let from_shortcut = s.icon.as_deref().and_then(|loc| {
        let (path, index) = match loc.rsplit_once(',') {
            Some((p, i)) => (p.trim(), i.trim().parse().unwrap_or(0)),
            None => (loc.trim(), 0),
        };
        (!path.is_empty()).then(|| (expand_env(path), index))
    });
    from_shortcut.or_else(|| s.target.clone().filter(|t| !t.is_empty()).map(|t| (t, 0)))
}

fn expand_env(path: &str) -> String {
    let mut out = path.to_string();
    for (var, value) in std::env::vars() {
        let pattern = format!("%{var}%");
        if let Some(at) = out.to_lowercase().find(&pattern.to_lowercase()) {
            out.replace_range(at..at + pattern.len(), &value);
        }
    }
    out
}

/// The library entry for an app. A site opens in an Edge window; everything else through the
/// shell, as the Start menu does.
pub fn game_of(entry: &AppEntry, edge: Option<&str>) -> Game {
    let launch = match (entry.kind.as_str(), edge) {
        ("site", Some(edge)) => Launch::Exe { path: edge.to_string(), args: vec![format!("--app={}", entry.target)], cwd: None },
        ("site", None) => Launch::Uri { uri: entry.target.clone() },
        ("file", _) if entry.target.to_lowercase().ends_with(".exe") => {
            Launch::Exe { path: entry.target.clone(), args: Vec::new(), cwd: entry.target.rsplit_once(['\\', '/']).map(|(dir, _)| dir.to_string()) }
        }
        // Shortcuts, .url and batch files: the shell runs them, a shortcut with its arguments.
        ("file", _) => Launch::Uri { uri: entry.target.clone() },
        _ => Launch::Uri { uri: format!(r"shell:AppsFolder\{}", entry.target) },
    };
    let mut game = Game::new("custom", entry.id(), entry.name.clone(), launch);
    game.id = format!("app:{}", entry.id());
    game.kind = Some("app".into());
    game.color = entry.color.clone();
    game.art.icon.extend(entry.icon.clone());
    match entry.kind.as_str() {
        "store" => game.install_dir = entry.location.clone(),
        "desktop" | "file" => {
            if let Some(exe) = &entry.exe {
                game.install_dir = exe.rsplit_once(['\\', '/']).map(|(dir, _)| dir.to_string());
                game.exe_names.extend(crate::model::exe_name(exe));
            }
        }
        "site" => game.site = Some(host(&entry.target)),
        // A site a browser installed runs inside that browser: nothing of its own to follow.
        _ => {}
    }
    game
}

/// "youtube.com" from "https://www.youtube.com/watch".
pub fn host(url: &str) -> String {
    let rest = url.split_once("://").map(|(_, r)| r).unwrap_or(url);
    let host = rest.split(['/', '?', '#']).next().unwrap_or(rest);
    host.trim_start_matches("www.").to_lowercase()
}

/// The best icon a Store app ships, and its tile colour. Logos come in sizes named like
/// `Square44x44Logo.targetsize-256_altform-unplated.png`; the biggest unplated one wins. The
/// app list's icon (44x44) fills its picture; the tile logo (150x150) sits in wide margins, so
/// it's only taken when the other has no big enough size.
pub fn store_visuals(location: &Path, app_id: &str) -> (Option<PathBuf>, Option<String>) {
    let Ok(text) = std::fs::read_to_string(location.join("AppxManifest.xml")) else { return (None, None) };
    let Ok(doc) = roxmltree::Document::parse(&text) else { return (None, None) };
    let app = app_id.rsplit_once('!').map(|(_, a)| a).unwrap_or(app_id);
    let application = doc.descendants().find(|n| n.has_tag_name("Application") && n.attribute("Id") == Some(app));
    let Some(visuals) = application.and_then(|a| a.descendants().find(|n| n.tag_name().name() == "VisualElements")) else { return (None, None) };
    let color = visuals.attribute("BackgroundColor").filter(|c| c.starts_with('#') && c.len() == 7).map(str::to_lowercase);
    let logo = |attr: &str| visuals.attribute(attr).and_then(|rel| best_logo(location, rel));
    let icon = match (logo("Square44x44Logo"), logo("Square150x150Logo")) {
        (Some((list, score)), _) if score >= 96 * 10 => Some(list),
        (list, tile) => list.into_iter().chain(tile).max_by_key(|(_, score)| *score).map(|(p, _)| p),
    };
    // The colour is the plate a tile logo sits on. An unplated icon is drawn for any background,
    // and on its own colour it can vanish: Spotify's green circle on Spotify green.
    let unplated = icon.as_ref().is_some_and(|p| p.to_string_lossy().to_lowercase().contains("unplated"));
    (icon, if unplated { None } else { color })
}

/// The largest variant of a logo on disk, with a score: its size in pixels, unplated ahead.
fn best_logo(location: &Path, rel: &str) -> Option<(PathBuf, u32)> {
    let path = location.join(rel.replace('\\', "/"));
    let dir = path.parent()?;
    let stem = path.file_stem()?.to_string_lossy().to_lowercase();
    let ext = path.extension()?.to_string_lossy().to_lowercase();
    let base: u32 = if stem.contains("44x44") { 44 } else if stem.contains("150x150") { 150 } else { 100 };
    let mut best = path.is_file().then(|| (path.clone(), base * 10));
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        let Some(qualifiers) = name.strip_prefix(&format!("{stem}.")).and_then(|q| q.strip_suffix(&format!(".{ext}"))) else { continue };
        let score = logo_score(qualifiers, base);
        if best.as_ref().is_none_or(|(_, s)| score > *s) {
            best = Some((entry.path(), score));
        }
    }
    best
}

/// `targetsize-256_altform-unplated` is 256 px; `scale-200` of a 150 px logo is 300 px. Ten
/// points per pixel, plus some for a transparent background over one baked into the picture.
fn logo_score(qualifiers: &str, base: u32) -> u32 {
    let mut px = base;
    for q in qualifiers.split(['_', '.']) {
        if let Some(n) = q.strip_prefix("targetsize-").and_then(|n| n.parse::<u32>().ok()) {
            px = n;
        } else if let Some(n) = q.strip_prefix("scale-").and_then(|n| n.parse::<u32>().ok()) {
            px = base * n / 100;
        }
    }
    let unplated = qualifiers.contains("unplated");
    let light = qualifiers.contains("light");
    px * 10 + if unplated { 5 } else { 0 } - if light { 3 } else { 0 }
}

/// A site's own icon: the biggest from its web app manifest, else its touch icon, else the
/// favicon. Returns the address to download.
pub fn icon_links(html: &str, base: &str) -> (Option<String>, Vec<String>) {
    let mut manifest = None;
    let mut icons: Vec<(u32, String)> = Vec::new();
    for tag in html.split("<link").skip(1).map(|t| t.split('>').next().unwrap_or("")) {
        let attr = |name: &str| attribute(tag, name);
        let rel = attr("rel").unwrap_or_default().to_lowercase();
        let Some(href) = attr("href") else { continue };
        let href = resolve(base, &href);
        if rel.split_whitespace().any(|r| r == "manifest") {
            manifest = Some(href);
        } else if rel.contains("apple-touch-icon") {
            icons.push((size_of(attr("sizes").as_deref()).max(180), href));
        } else if rel.split_whitespace().any(|r| r == "icon") {
            icons.push((size_of(attr("sizes").as_deref()), href));
        }
    }
    icons.sort_by(|a, b| b.0.cmp(&a.0));
    let mut out: Vec<String> = icons.into_iter().map(|(_, h)| h).collect();
    out.push(resolve(base, "/favicon.ico"));
    (manifest, out)
}

/// The biggest icon a web app manifest lists, for any purpose other than only "maskable".
pub fn manifest_icon(json: &serde_json::Value, base: &str) -> Option<String> {
    let icons = json.get("icons")?.as_array()?;
    let pick = |maskable_ok: bool| {
        icons
            .iter()
            .filter(|i| maskable_ok || i.get("purpose").and_then(|p| p.as_str()).is_none_or(|p| p.split_whitespace().any(|p| p == "any")))
            .filter_map(|i| Some((size_of(i.get("sizes").and_then(|s| s.as_str())), i.get("src")?.as_str()?)))
            .max_by_key(|(size, _)| *size)
            .map(|(_, src)| resolve(base, src))
    };
    pick(false).or_else(|| pick(true))
}

fn size_of(sizes: Option<&str>) -> u32 {
    sizes.unwrap_or("").split_whitespace().filter_map(|s| s.split(['x', 'X']).next()?.parse().ok()).max().unwrap_or(0)
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_lowercase();
    let mut from = 0;
    while let Some(at) = lower[from..].find(&format!("{name}=")) {
        let start = from + at;
        from = start + name.len() + 1;
        // Whole attribute names only: "href" isn't the end of "hreflang".
        if start > 0 && !lower.as_bytes()[start - 1].is_ascii_whitespace() {
            continue;
        }
        let rest = &tag[from..];
        let value = match rest.chars().next()? {
            q @ ('"' | '\'') => rest[1..].split(q).next()?,
            _ => rest.split(|c: char| c.is_whitespace() || c == '/').next()?,
        };
        return Some(value.replace("&amp;", "&"));
    }
    None
}

/// An address from a page's link, made absolute against the page.
fn resolve(base: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") {
        return href.to_string();
    }
    let (scheme, rest) = base.split_once("://").unwrap_or(("https", base));
    let origin = rest.split('/').next().unwrap_or(rest);
    if let Some(protocol_relative) = href.strip_prefix("//") {
        return format!("{scheme}://{protocol_relative}");
    }
    if href.starts_with('/') {
        return format!("{scheme}://{origin}{href}");
    }
    let dir = base.rsplit_once('/').filter(|(d, _)| d.len() > scheme.len() + 3).map(|(d, _)| d).unwrap_or(base.trim_end_matches('/'));
    format!("{dir}/{href}")
}

/// Downloads a site's icon into `dir`, named after the app. Requests go to the site itself.
pub async fn fetch_site_icon(url: &str, dir: &Path, id: &str) -> Option<String> {
    let http = crate::art::client();
    let html = http.get(url).send().await.ok()?.text().await.ok()?;
    let (manifest, mut icons) = icon_links(&html, url);
    if let Some(manifest) = manifest {
        if let Ok(resp) = http.get(&manifest).send().await {
            if let Ok(json) = resp.json::<serde_json::Value>().await {
                if let Some(icon) = manifest_icon(&json, &manifest) {
                    icons.insert(0, icon);
                }
            }
        }
    }
    for icon in icons {
        let Ok(resp) = http.get(&icon).send().await else { continue };
        if !resp.status().is_success() {
            continue;
        }
        let kind = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
        let ext = match kind.as_str() {
            k if k.contains("png") => "png",
            k if k.contains("svg") => "svg",
            k if k.contains("webp") => "webp",
            k if k.contains("jpeg") || k.contains("jpg") => "jpg",
            k if k.contains("icon") => "ico",
            _ => continue,
        };
        let Ok(bytes) = resp.bytes().await else { continue };
        if bytes.is_empty() || bytes.len() > 2 * 1024 * 1024 {
            continue;
        }
        let path = dir.join(format!("{id}.{ext}"));
        if std::fs::create_dir_all(dir).is_ok() && std::fs::write(&path, &bytes).is_ok() {
            return Some(path.to_string_lossy().to_string());
        }
    }
    None
}

/// Edge, which opens a site in a window of its own with `--app`.
#[cfg(windows)]
pub fn edge() -> Option<String> {
    use winreg::{enums::HKEY_LOCAL_MACHINE, RegKey};
    let registered = RegKey::predef(HKEY_LOCAL_MACHINE)
        .open_subkey(r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe")
        .and_then(|k| k.get_value::<String, _>(""))
        .ok();
    registered
        .into_iter()
        .chain([r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe".to_string(), r"C:\Program Files\Microsoft\Edge\Application\msedge.exe".to_string()])
        .find(|p| Path::new(p).is_file())
}

#[cfg(not(windows))]
pub fn edge() -> Option<String> {
    None
}

/// Every Start menu entry with what's needed to tell its kind: shortcuts' targets, Store
/// apps' folders.
#[cfg(windows)]
const START_QUERY: &str = r#"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'SilentlyContinue'
$sh = New-Object -ComObject WScript.Shell
$lnk = @{}
foreach ($r in @("$env:APPDATA\Microsoft\Windows\Start Menu\Programs", "$env:ProgramData\Microsoft\Windows\Start Menu\Programs")) {
  if (Test-Path -LiteralPath $r) {
    Get-ChildItem -LiteralPath $r -Recurse -Filter *.lnk | ForEach-Object {
      if (-not $lnk.ContainsKey($_.BaseName)) {
        $s = $sh.CreateShortcut($_.FullName)
        $lnk[$_.BaseName] = @{ target = $s.TargetPath; args = $s.Arguments; icon = $s.IconLocation }
      }
    }
  }
}
$pk = @{}
Get-AppxPackage | ForEach-Object { $pk[$_.PackageFamilyName] = $_.InstallLocation }
$out = Get-StartApps | ForEach-Object {
  $fam = $null
  if ($_.AppID -match '^([^!\\]+)!') { $fam = $Matches[1] }
  $l = $lnk[$_.Name]
  [pscustomobject]@{ name = $_.Name; appId = $_.AppID; location = $(if ($fam) { $pk[$fam] } else { $null }); target = $l.target; args = $l.args; icon = $l.icon }
}
ConvertTo-Json -InputObject @($out) -Compress
"#;

#[cfg(windows)]
pub fn start_apps() -> Vec<StartApp> {
    let Some(text) = crate::pick::run_powershell(START_QUERY) else { return Vec::new() };
    serde_json::from_str(text.trim().trim_start_matches('\u{feff}')).unwrap_or_default()
}

#[cfg(not(windows))]
pub fn start_apps() -> Vec<StartApp> {
    Vec::new()
}

/// What not to offer: apps on the tab already (by what launches them), and the library's games.
#[derive(Default)]
pub struct Exclude {
    pub taken: Vec<String>,
    pub game_dirs: Vec<String>,
    pub game_names: Vec<String>,
}

/// Apps the Start menu has, with icons, that `keep` wants: what "Add an app" offers, or the
/// known apps that join the tab by themselves. Known media and chat apps come first.
pub fn discover(icons: &Path, exclude: &Exclude, keep: impl Fn(&AppEntry) -> bool) -> Vec<AppEntry> {
    discover_from(&start_apps(), icons, exclude, keep)
}

/// Brings apps on the tab up to date with the Start menu: a Store app moves to a new folder,
/// named after its version, each time it updates, and its logos with it. Returns whether any
/// changed.
pub fn refresh(list: &[StartApp], entries: &mut [AppEntry]) -> bool {
    let mut changed = false;
    for entry in entries.iter_mut().filter(|e| e.kind == "store") {
        let Some(location) = list.iter().find(|s| s.app_id == entry.target).and_then(|s| s.location.clone()) else { continue };
        let (icon, color) = store_visuals(Path::new(&location), &entry.target);
        let icon = icon.map(|p| p.to_string_lossy().to_string());
        if entry.location.as_ref() != Some(&location) || entry.icon != icon || entry.color != color {
            (entry.location, entry.icon, entry.color) = (Some(location), icon, color);
            changed = true;
        }
    }
    changed
}

/// Apps on the tab that are still installed: an app uninstalled after it joined the tab would
/// only fail to open. It stays saved, and comes back if it's installed again. A site is always
/// there; a file is there while it exists; Start menu apps are all there when the Start menu
/// couldn't be read at all.
pub fn installed(list: &[StartApp], entries: &[AppEntry]) -> Vec<AppEntry> {
    entries
        .iter()
        .filter(|e| match e.kind.as_str() {
            "site" => true,
            "file" => Path::new(&e.target).exists(),
            _ => list.is_empty() || list.iter().any(|s| s.app_id == e.target),
        })
        .cloned()
        .collect()
}

/// An app from a file the player picked: an exe, a shortcut, a .url or a batch file. `exe` is
/// the program it runs, which is what shows up as its process.
pub fn from_file(path: &str, name: String, exe: Option<String>) -> AppEntry {
    AppEntry { name, kind: "file".into(), target: path.to_string(), exe, ..Default::default() }
}

/// [`discover`] over a Start menu list already read.
pub fn discover_from(list: &[StartApp], icons: &Path, exclude: &Exclude, keep: impl Fn(&AppEntry) -> bool) -> Vec<AppEntry> {
    let dirs: Vec<String> = exclude.game_dirs.iter().map(|d| d.to_lowercase()).collect();
    let names: Vec<String> = exclude.game_names.iter().map(|n| n.to_lowercase()).collect();
    let taken = &exclude.taken;
    let mut found: Vec<AppEntry> = Vec::new();
    for s in list {
        let Some(mut entry) = classify(s) else { continue };
        let place = entry.location.clone().or_else(|| entry.exe.clone()).unwrap_or_default().to_lowercase();
        let is_game = names.contains(&entry.name.to_lowercase()) || (!place.is_empty() && dirs.iter().any(|d| place.starts_with(d.as_str())));
        if is_game || entry.name.eq_ignore_ascii_case("mantel") || taken.contains(&entry.target) || found.iter().any(|f| f.target == entry.target) || !keep(&entry) {
            continue;
        }
        if entry.kind == "store" {
            let (icon, color) = store_visuals(Path::new(entry.location.as_deref().unwrap_or("")), &entry.target);
            entry.icon = icon.map(|p| p.to_string_lossy().to_string());
            entry.color = color;
        } else if let Some((path, index)) = icon_source(s) {
            let out = icons.join(format!("{}.png", entry.id()));
            if out.is_file() || crate::icons::extract(&path, index, &out) {
                entry.icon = Some(out.to_string_lossy().to_string());
            }
        }
        found.push(entry);
    }
    found.sort_by_key(|e| (!is_known(&e.name), e.name.to_lowercase()));
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    fn start(name: &str, app_id: &str, location: Option<&str>, target: Option<&str>, args: Option<&str>) -> StartApp {
        StartApp { name: name.into(), app_id: app_id.into(), location: location.map(Into::into), target: target.map(Into::into), args: args.map(Into::into), icon: None }
    }

    #[test]
    fn tells_store_apps_programs_and_installed_sites_apart() {
        let store = classify(&start("Netflix", "4DF9E0F8.Netflix_mcm4njqhnhss8!Netflix.App", Some(r"C:\Program Files\WindowsApps\Netflix"), None, None)).unwrap();
        assert_eq!((store.kind.as_str(), store.location.as_deref()), ("store", Some(r"C:\Program Files\WindowsApps\Netflix")));
        let program = classify(&start("Spotify", "Spotify", None, Some(r"C:\Users\p\AppData\Roaming\Spotify\Spotify.exe"), None)).unwrap();
        assert_eq!((program.kind.as_str(), program.target.as_str()), ("desktop", "Spotify"));
        let site = classify(&start("YouTube", "msedge._crx_agimnkijcaahngcdmfeangaknmldooml", None, Some(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge_proxy.exe"), Some("--profile-directory=Default --app-id=agimnkijcaahngcdmfeangaknmldooml"))).unwrap();
        assert_eq!(site.kind, "web");
    }

    #[test]
    fn leaves_out_uninstallers_system_tools_and_shell_items() {
        assert!(classify(&start("Uninstall Spotify", "x", None, Some(r"C:\x\unins000.exe"), None)).is_none());
        assert!(classify(&start("Notepad", "x", None, Some(r"C:\Windows\System32\notepad.exe"), None)).is_none());
        assert!(classify(&start("Control Panel", "Microsoft.Windows.ControlPanel", None, None, None)).is_none());
    }

    #[test]
    fn knows_media_and_chat_apps() {
        assert!(is_known("Microsoft Store"));
        assert!(is_known("Microsoft Edge"));
        assert!(is_known("Spotify"));
        assert!(is_known("Prime Video for Windows"));
        assert!(is_known("VLC media player"));
        assert!(!is_known("Spotifyx"));
        assert!(!is_known("Calculator"));
    }

    #[test]
    fn a_site_opens_in_an_edge_window_and_isnt_followed() {
        let site = AppEntry { name: "YouTube".into(), kind: "site".into(), target: "https://www.youtube.com".into(), ..Default::default() };
        let game = game_of(&site, Some(r"C:\Edge\msedge.exe"));
        assert!(matches!(&game.launch, Launch::Exe { args, .. } if args == &["--app=https://www.youtube.com"]));
        assert_eq!((game.site.as_deref(), game.install_dir.as_deref(), game.kind.as_deref()), (Some("youtube.com"), None, Some("app")));
        assert!(game.id.starts_with("app:"));
    }

    #[test]
    fn a_site_opens_in_the_default_browser_without_edge() {
        let site = AppEntry { name: "Twitch".into(), kind: "site".into(), target: "https://www.twitch.tv".into(), ..Default::default() };
        assert!(matches!(&game_of(&site, None).launch, Launch::Uri { uri } if uri == "https://www.twitch.tv"));
    }

    #[test]
    fn data_from_before_apps_starts_with_an_empty_tab() {
        // 0.4.6 saved neither list: an update reads them as empty, and the first scan fills the tab
        // with whatever known apps this PC has, none at all if it has none.
        let user: crate::store::UserData = serde_json::from_str(r#"{"settings":{},"meta":{},"custom":[]}"#).unwrap();
        assert!(user.apps.is_empty() && user.dismissed_apps.is_empty());
        let exclude = Exclude { taken: user.dismissed_apps.clone(), ..Default::default() };
        let spotify_only = [start("Spotify", "SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify", Some(r"C:\WindowsApps\Spotify"), None, None)];
        let names: Vec<String> = discover_from(&spotify_only, &std::env::temp_dir(), &exclude, |a| is_known(&a.name)).into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["Spotify"]);
    }

    #[test]
    fn a_program_is_followed_by_its_folder_and_exe() {
        let app = AppEntry { name: "Discord".into(), kind: "desktop".into(), target: "com.squirrel.Discord.Discord".into(), exe: Some(r"C:\Users\p\AppData\Local\Discord\Update.exe".into()), ..Default::default() };
        let game = game_of(&app, None);
        assert!(matches!(&game.launch, Launch::Uri { uri } if uri == r"shell:AppsFolder\com.squirrel.Discord.Discord"));
        assert_eq!(game.install_dir.as_deref(), Some(r"C:\Users\p\AppData\Local\Discord"));
        assert_eq!(game.exe_names, ["update.exe"]);
        assert_eq!(game.id, game_of(&app, None).id);
    }

    #[test]
    fn picks_the_biggest_unplated_store_logo() {
        let dir = std::env::temp_dir().join(format!("mantel-logos-{}", std::process::id()));
        let assets = dir.join("Assets");
        std::fs::create_dir_all(&assets).unwrap();
        // The tile logo's 600 px beat 256 px on size alone, but it's mostly margin.
        for f in ["Square44x44Logo.scale-200.png", "Square44x44Logo.targetsize-256.png", "Square44x44Logo.targetsize-256_altform-unplated.png", "Square150x150Logo.scale-400.png"] {
            std::fs::write(assets.join(f), b"x").unwrap();
        }
        std::fs::write(
            dir.join("AppxManifest.xml"),
            r##"<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10" xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"><Applications><Application Id="App"><uap:VisualElements DisplayName="Music" Square44x44Logo="Assets\Square44x44Logo.png" Square150x150Logo="Assets\Square150x150Logo.png" BackgroundColor="#1DB954"/></Application></Applications></Package>"##,
        )
        .unwrap();
        let (icon, color) = store_visuals(&dir, "Some.Music_abc!App");
        assert_eq!(icon.unwrap().file_name().unwrap(), "Square44x44Logo.targetsize-256_altform-unplated.png");
        // The plate colour goes with plated logos only.
        assert_eq!(color, None);
        std::fs::remove_file(dir.join("Assets").join("Square44x44Logo.targetsize-256_altform-unplated.png")).unwrap();
        let (icon, color) = store_visuals(&dir, "Some.Music_abc!App");
        assert_eq!(icon.unwrap().file_name().unwrap(), "Square44x44Logo.targetsize-256.png");
        assert_eq!(color.as_deref(), Some("#1db954"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn known_apps_join_only_when_installed() {
        let icons = std::env::temp_dir();
        let store = start("Microsoft Store", "Microsoft.WindowsStore_8wekyb3d8bbwe!App", Some(r"C:\Program Files\WindowsApps\Store"), None, None);
        let edge = start("Microsoft Edge", "MSEdge", None, Some(r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"), None);
        let notes = start("Notes", "Some.Notes_x!App", Some(r"C:\Program Files\WindowsApps\Notes"), None, None);
        let known = |a: &AppEntry| is_known(&a.name);
        // A PC with neither: nothing joins, and nothing goes wrong.
        assert!(discover_from(&[notes], &icons, &Exclude::default(), known).is_empty());
        assert!(discover_from(&[], &icons, &Exclude::default(), known).is_empty());
        let both = [store, edge, start("Notes", "Some.Notes_x!App", None, None, None)];
        let names: Vec<String> = discover_from(&both, &icons, &Exclude::default(), known).into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["Microsoft Edge", "Microsoft Store"]);
        // Taken off the tab: it doesn't come back by itself.
        let exclude = Exclude { taken: vec!["MSEdge".into()], ..Default::default() };
        let names: Vec<String> = discover_from(&both, &icons, &exclude, known).into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["Microsoft Store"]);
    }

    #[test]
    fn a_picked_file_launches_itself_and_is_followed_by_its_program() {
        let exe = from_file(r"C:\Tools\Player\player.exe", "Player".into(), Some(r"C:\Tools\Player\player.exe".into()));
        let game = game_of(&exe, None);
        assert!(matches!(&game.launch, Launch::Exe { path, cwd, .. } if path == r"C:\Tools\Player\player.exe" && cwd.as_deref() == Some(r"C:\Tools\Player")));
        assert_eq!((game.install_dir.as_deref(), game.exe_names.as_slice()), (Some(r"C:\Tools\Player"), &["player.exe".to_string()][..]));
        let lnk = from_file(r"C:\Users\p\Desktop\Player.lnk", "Player".into(), Some(r"C:\Tools\Player\player.exe".into()));
        assert!(matches!(&game_of(&lnk, None).launch, Launch::Uri { uri } if uri == r"C:\Users\p\Desktop\Player.lnk"));
        // Gone from disk: off the tab.
        assert!(installed(&[], &[lnk]).is_empty());
    }

    #[test]
    fn an_uninstalled_app_leaves_the_tab_until_it_returns() {
        let entries = [
            AppEntry { name: "Spotify".into(), kind: "store".into(), target: "Spotify_x!Spotify".into(), ..Default::default() },
            AppEntry { name: "Edge".into(), kind: "desktop".into(), target: "MSEdge".into(), ..Default::default() },
            AppEntry { name: "YouTube".into(), kind: "site".into(), target: "https://www.youtube.com".into(), ..Default::default() },
        ];
        let without_spotify = [start("Microsoft Edge", "MSEdge", None, None, None)];
        let names: Vec<String> = installed(&without_spotify, &entries).into_iter().map(|a| a.name).collect();
        assert_eq!(names, ["Edge", "YouTube"]);
        // The Start menu couldn't be read: keep everything rather than empty the tab.
        assert_eq!(installed(&[], &entries).len(), 3);
    }

    #[test]
    fn follows_a_store_app_to_its_new_folder() {
        let dir = std::env::temp_dir().join(format!("mantel-store-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("Assets")).unwrap();
        std::fs::write(dir.join("Assets").join("List.targetsize-256_altform-unplated.png"), b"x").unwrap();
        std::fs::write(
            dir.join("AppxManifest.xml"),
            r#"<Package><Applications><Application Id="App"><VisualElements Square44x44Logo="Assets\List.png"/></Application></Applications></Package>"#,
        )
        .unwrap();
        let mut entries = vec![AppEntry { name: "Store".into(), kind: "store".into(), target: "Store_x!App".into(), location: Some(r"C:\old".into()), ..Default::default() }];
        let list = [StartApp { name: "Store".into(), app_id: "Store_x!App".into(), location: Some(dir.to_string_lossy().to_string()), ..Default::default() }];
        assert!(refresh(&list, &mut entries));
        assert_eq!(entries[0].location.as_deref(), Some(dir.to_string_lossy().as_ref()));
        assert!(entries[0].icon.as_deref().is_some_and(|i| i.ends_with("List.targetsize-256_altform-unplated.png")));
        assert!(!refresh(&list, &mut entries));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn finds_a_sites_icons() {
        let html = r#"<head><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" sizes="32x32" href="/i32.png"><link rel="apple-touch-icon" href="https://cdn.example/touch.png"><link hreflang="en" rel="alternate" href="/en"></head>"#;
        let (manifest, icons) = icon_links(html, "https://www.example.com/watch");
        assert_eq!(manifest.as_deref(), Some("https://www.example.com/manifest.webmanifest"));
        assert_eq!(icons, ["https://cdn.example/touch.png", "https://www.example.com/i32.png", "https://www.example.com/favicon.ico"]);
        let json = serde_json::json!({ "icons": [
            { "src": "icons/192.png", "sizes": "192x192" },
            { "src": "icons/512-mask.png", "sizes": "512x512", "purpose": "maskable" },
            { "src": "icons/256.png", "sizes": "256x256", "purpose": "any maskable" }
        ]});
        assert_eq!(manifest_icon(&json, "https://www.example.com/app/manifest.json").as_deref(), Some("https://www.example.com/app/icons/256.png"));
    }

    #[test]
    fn names_a_sites_host() {
        assert_eq!(host("https://www.youtube.com"), "youtube.com");
        assert_eq!(host("https://play.geforcenow.com/mall/"), "play.geforcenow.com");
    }
}
