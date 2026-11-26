//! Uninstalling games: Store packages through Windows directly, Steam games through Steam's own
//! dialog, games added by hand through the uninstaller Windows lists for them. Either way
//! "game-uninstalled" says when the game is gone.

use std::path::Path;
use std::time::{Duration, Instant};

use sysinfo::System;
use tauri::{AppHandle, Emitter, Manager};

use crate::model::{Game, Launch};

/// How long Steam's dialog may wait for an answer before Mantel stops watching for one.
const STEAM_WAIT: Duration = Duration::from_secs(600);
/// How long a game's own uninstaller may take, questions and all, before Mantel stops watching.
const PROGRAM_WAIT: Duration = Duration::from_secs(1800);

/// A program in Windows' list of installed apps: what it's called, its folder, and the command
/// that removes it.
#[derive(Debug, Clone, PartialEq)]
pub struct Program {
    pub name: String,
    pub location: String,
    pub command: String,
}

/// Folders many programs share. An uninstaller listed for one of them never stands for one game.
const SHARED: &[&str] = &["program files", "program files (x86)", "programdata", "users", "windows", "games", "steamlibrary", "steamapps", "common", "programs"];

/// A folder as Windows compares them: any case, backslashes, no trailing slash.
fn folder(path: &str) -> String {
    path.trim().replace('/', "\\").trim_end_matches('\\').to_lowercase()
}

/// A name with only its letters and digits, lower case, "&" read as "and": "Ori & the Wisps™"
/// is "oriandthewisps".
fn letters(name: &str) -> String {
    name.replace('&', "and").chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

/// Whether two names are the same game: equal, or one starting the other and two thirds of its
/// length or more, as "Hades" and "Hades II". "Steam" is not "SteamWorld Dig".
fn same_name(a: &str, b: &str) -> bool {
    let (a, b) = (letters(a), letters(b));
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    short.len() >= 3 && long.starts_with(&short) && short.len() * 3 >= long.len() * 2
}

/// The program a game added by hand belongs to: the one whose folder holds the game and whose
/// name is the game's. The name has to match too, since a launcher such as Steam holds many games
/// in its folder. When several match, the one in the deepest folder.
pub fn owner<'a>(programs: &'a [Program], dir: &str, names: &[&str]) -> Option<&'a Program> {
    let dir = folder(dir);
    programs
        .iter()
        .filter(|p| {
            let at = folder(&p.location);
            let last = at.rsplit('\\').next().unwrap_or_default();
            at.len() > 3 && !SHARED.contains(&last) && (dir == at || dir.starts_with(&format!("{at}\\")))
        })
        .filter(|p| names.iter().any(|n| same_name(n, &p.name)))
        .max_by_key(|p| folder(&p.location).len())
}

/// An uninstall command split into the program and its arguments: `"C:\x\unins000.exe" /SILENT`
/// or `MsiExec.exe /X{…}`.
fn split_command(command: &str) -> (String, String) {
    let command = command.trim();
    if let Some(rest) = command.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return (rest[..end].to_string(), rest[end + 1..].trim().to_string());
        }
    }
    match command.as_bytes().windows(4).position(|w| w.eq_ignore_ascii_case(b".exe")) {
        Some(at) => (command[..at + 4].to_string(), command[at + 4..].trim().to_string()),
        None => (command.to_string(), String::new()),
    }
}

/// Windows' list of installed programs: 64- and 32-bit, for the machine and for this user. A
/// program without a folder of its own gets its uninstaller's, where Inno Setup puts it.
#[cfg(windows)]
pub fn programs() -> Vec<Program> {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY};
    use winreg::RegKey;
    const LIST: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
    let mut out = Vec::new();
    for (root, flags) in [(HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_64KEY), (HKEY_LOCAL_MACHINE, KEY_READ | KEY_WOW64_32KEY), (HKEY_CURRENT_USER, KEY_READ)] {
        let Ok(list) = RegKey::predef(root).open_subkey_with_flags(LIST, flags) else { continue };
        for key in list.enum_keys().flatten() {
            let Ok(entry) = list.open_subkey_with_flags(&key, flags) else { continue };
            let value = |name: &str| entry.get_value::<String, _>(name).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
            let (Some(name), Some(command)) = (value("DisplayName"), value("UninstallString")) else { continue };
            let location = value("InstallLocation").or_else(|| {
                let program = split_command(&command).0;
                Path::new(&program).is_absolute().then(|| Path::new(&program).parent().map(|p| p.to_string_lossy().to_string())).flatten()
            });
            if let Some(location) = location {
                out.push(Program { name, location, command });
            }
        }
    }
    out
}

#[cfg(not(windows))]
pub fn programs() -> Vec<Program> {
    Vec::new()
}

/// The names a game added by hand goes by: its own, and its shortcut's or exe's.
fn names(game: &Game) -> Vec<String> {
    let file = match &game.launch {
        Launch::Uri { uri } => uri,
        Launch::Exe { path, .. } => path,
    };
    let stem = Path::new(file).file_stem().map(|s| s.to_string_lossy().to_string());
    std::iter::once(game.name.clone()).chain(stem).collect()
}

/// The program that can uninstall a game added by hand, if Windows lists one.
pub fn program_for(game: &Game) -> Option<Program> {
    let dir = game.install_dir.as_deref()?;
    let names = names(game);
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    owner(&programs(), dir, &names).cloned()
}

/// Starts a program the way Explorer would, so Windows asks for administrator rights when the
/// program needs them.
#[cfg(windows)]
fn run(program: &str, args: &str) -> Result<(), String> {
    use windows_sys::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let (verb, file, params) = (wide("open"), wide(program), wide(args));
    let code = std::thread::spawn(move || unsafe {
        CoInitializeEx(std::ptr::null(), (COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) as u32);
        let r = ShellExecuteW(std::ptr::null_mut(), verb.as_ptr(), file.as_ptr(), params.as_ptr(), std::ptr::null(), SW_SHOWNORMAL);
        CoUninitialize();
        r as isize
    })
    .join()
    .map_err(|_| "ShellExecute panicked".to_string())?;
    // Values above 32 mean success.
    if code > 32 {
        Ok(())
    } else {
        Err(format!("Windows couldn't start the uninstaller (code {code})"))
    }
}

#[cfg(not(windows))]
fn run(_program: &str, _args: &str) -> Result<(), String> {
    Err("Uninstalling needs Windows".into())
}

/// A game added by hand goes through its own uninstaller, which asks the player itself. Once the
/// game's exe is gone, Mantel forgets the game too.
fn by_program(app: &AppHandle, game: &Game) -> Result<(), String> {
    let program = program_for(game).ok_or("Windows doesn't list an uninstaller for this game")?;
    let exe = game.install_dir.as_deref().zip(game.exe_names.first()).map(|(dir, exe)| Path::new(dir).join(exe)).ok_or("Mantel doesn't know this game's exe")?;
    let (file, args) = split_command(&program.command);
    crate::log::info(&format!("uninstall {} with {}", game.id, program.command));
    run(&file, &args)?;
    let (app, id) = (app.clone(), game.id.clone());
    std::thread::spawn(move || {
        let start = Instant::now();
        while start.elapsed() < PROGRAM_WAIT {
            std::thread::sleep(Duration::from_secs(2));
            if !exe.exists() {
                app.state::<crate::store::AppState>().forget_custom(&id);
                crate::launcher::to_front(&app);
                return gone(&app, &id);
            }
        }
    });
    Ok(())
}

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
        "custom" => by_program(app, game),
        _ => Err("Mantel can only uninstall Xbox and Steam games for now".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn program(name: &str, location: &str) -> Program {
        Program { name: name.into(), location: location.into(), command: format!(r#""{location}\unins000.exe""#) }
    }

    #[test]
    fn a_game_belongs_to_the_program_in_its_folder_with_its_name() {
        let list = [
            program("Steam", r"C:\Program Files (x86)\Steam"),
            program("Ori and the Will of the Wisps", r"C:\Program Files (x86)\Ori and the Will of the Wisps\"),
            program("Alan Wake 2", r"C:\Program Files (x86)\Alan Wake 2\"),
        ];
        let found = owner(&list, r"C:\Program Files (x86)\Ori and the Will of the Wisps", &["Ori & the Will of the Wisps"]);
        assert_eq!(found.map(|p| p.name.as_str()), Some("Ori and the Will of the Wisps"));
        // Its exe deep inside, and the name Mantel read from the exe.
        let found = owner(&list, r"c:/program files (x86)/alan wake 2/bin/x64", &["Alan Wake 2", "AlanWake2_x64"]);
        assert_eq!(found.map(|p| p.name.as_str()), Some("Alan Wake 2"));
    }

    #[test]
    fn a_launcher_never_stands_for_a_game_in_its_folder() {
        let list = [program("Steam", r"C:\Program Files (x86)\Steam"), program("Games", r"D:\Games")];
        assert_eq!(owner(&list, r"C:\Program Files (x86)\Steam\steamapps\common\SteamWorld Dig", &["SteamWorld Dig"]), None);
        assert_eq!(owner(&list, r"D:\Games\Celeste", &["Games"]), None);
        assert_eq!(owner(&[program("Celeste", r"C:\")], r"C:\Celeste", &["Celeste"]), None);
    }

    #[test]
    fn a_sequel_is_not_its_first_game_unless_the_name_is_most_of_it() {
        assert!(same_name("Hades", "Hades II"));
        assert!(same_name("Ori & the Will of the Wisps™", "Ori and the Will of the Wisps"));
        assert!(!same_name("Steam", "SteamWorld Dig"));
        assert!(!same_name("GTA", "GTA V Enhanced Edition"));
    }

    #[test]
    fn splits_uninstall_commands() {
        assert_eq!(split_command(r#""C:\Games\X\unins000.exe" /SILENT"#), (r"C:\Games\X\unins000.exe".into(), "/SILENT".into()));
        assert_eq!(split_command("MsiExec.exe /X{1234}"), ("MsiExec.exe".into(), "/X{1234}".into()));
        assert_eq!(split_command(r"C:\Program Files\Y\uninstall.EXE"), (r"C:\Program Files\Y\uninstall.EXE".into(), String::new()));
    }

    #[test]
    fn checks_package_names() {
        assert!(checked("CRITICALREFLEX.Mouthwashing_20ymd9g5r2c54").is_ok());
        assert!(checked("x'; Remove-Item C:\\").is_err());
        assert!(checked("").is_err());
    }
}
