//! Uninstalling games: Store packages through Windows directly, Steam games through Steam's own
//! dialog. Either way "game-uninstalled" says when the game is gone.

use std::path::Path;
use std::time::{Duration, Instant};

use sysinfo::System;
use tauri::{AppHandle, Emitter};

use crate::model::Game;

/// How long Steam's dialog may wait for an answer before Mantel stops watching for one.
const STEAM_WAIT: Duration = Duration::from_secs(600);

/// Prints nothing, or "error <message>" when Windows refuses.
#[cfg(windows)]
const REMOVE: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  $p = Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq '{family}' }
  if (-not $p) { 'error This game is no longer installed'; exit }
  $p | Remove-AppxPackage
} catch {
  'error {0}' -f ($_.Exception.Message -split "`n")[0]
}
"#;

/// Package family names are letters, digits, dots, dashes and underscores; anything else never
/// reaches a script.
fn checked(family: &str) -> Result<&str, String> {
    (!family.is_empty() && family.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_')))
        .then_some(family)
        .ok_or_else(|| format!("Not a Store package: {family}"))
}

#[cfg(windows)]
fn remove_package(family: &str) -> Result<(), String> {
    let out = crate::install::powershell(&REMOVE.replace("{family}", checked(family)?)).output().map_err(|e| format!("Couldn't start the uninstaller: {e}"))?;
    match String::from_utf8_lossy(&out.stdout).lines().find_map(|l| l.trim().strip_prefix("error ")) {
        Some(message) => Err(message.trim().to_string()),
        None => Ok(()),
    }
}

#[cfg(not(windows))]
fn remove_package(family: &str) -> Result<(), String> {
    checked(family)?;
    Err("Uninstalling needs Windows".into())
}

/// Steam asks the player itself and does the removing; the game's manifest going away says it's
/// done. It sits two folders above the game: steamapps/common/<game>.
fn steam(app: &AppHandle, game: &Game) -> Result<(), String> {
    let dir = game.install_dir.as_deref().ok_or("Steam didn't say where this game is")?;
    let apps = Path::new(dir).parent().and_then(Path::parent).ok_or("Steam didn't say where this game is")?;
    let manifest = apps.join(format!("appmanifest_{}.acf", game.source_id));
    let before = crate::launcher::steam_dialogs(&mut System::new());
    crate::launcher::open_external(&format!("steam://uninstall/{}", game.source_id))?;
    let (app, id) = (app.clone(), game.id.clone());
    std::thread::spawn(move || {
        let start = Instant::now();
        let (mut sys, mut dialog) = (System::new(), false);
        while start.elapsed() < STEAM_WAIT {
            std::thread::sleep(Duration::from_secs(1));
            // Steam's main window stays up in front of Mantel, whichever way the dialog goes.
            if !manifest.exists() {
                crate::launcher::to_front(&app);
                return gone(&app, &id);
            }
            let up = crate::launcher::steam_dialogs(&mut sys).iter().any(|d| !before.contains(d));
            if dialog && !up {
                crate::launcher::to_front(&app);
            }
            dialog = up;
        }
    });
    Ok(())
}

fn gone(app: &AppHandle, id: &str) {
    crate::log::info(&format!("uninstalled {id}"));
    let _ = app.emit("game-uninstalled", id);
}

/// Starts removing an installed game. A Store game is gone when this returns; Steam's dialog
/// stays open after it.
pub fn start(app: &AppHandle, game: &Game) -> Result<(), String> {
    crate::log::info(&format!("uninstall {}", game.id));
    match game.source.as_str() {
        "xbox" => remove_package(&game.source_id).map(|_| gone(app, &game.id)),
        "steam" => steam(app, game),
        _ => Err("Mantel can only uninstall Xbox and Steam games for now".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_package_names() {
        assert!(checked("CRITICALREFLEX.Mouthwashing_20ymd9g5r2c54").is_ok());
        assert!(checked("x'; Remove-Item C:\\").is_err());
        assert!(checked("").is_err());
    }
}
