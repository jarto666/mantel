//! An update while Mantel is the home app of Xbox mode. The updater hides Mantel's window, waits
//! for Windows to start the installer (it checks a freshly downloaded program first: 4 s on the
//! Ally), and exits; the installer closes any copy still running, replaces the files and
//! registers the package, which closes the new copy once more. Xbox mode opens its home app
//! again each time, at once. A Mantel that starts while an install is under way says so and
//! waits, rather than showing the old version and scanning everything only to be closed.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::model::now;

const MARKER: &str = "updating.json";
/// An install that takes longer than this has failed, whatever the marker says.
const MARKER_TTL: i64 = 10 * 60;
/// How long the installer may take to show up after the updater started it.
const STARTING: i64 = 60;

#[derive(Debug, Serialize, Deserialize)]
struct Marker {
    version: String,
    at: i64,
}

/// Left by the copy that starts the installer, right before it does.
pub fn begin(dir: &Path, version: &str) {
    let marker = Marker { version: version.to_string(), at: now() };
    if let Ok(bytes) = serde_json::to_vec(&marker) {
        let _ = std::fs::create_dir_all(dir);
        let _ = std::fs::write(dir.join(MARKER), bytes);
    }
}

/// The update didn't start after all: the installer never ran.
pub fn end(dir: &Path) {
    let _ = std::fs::remove_file(dir.join(MARKER));
}

/// The version being installed, while the update is under way for a copy of version `own`. A
/// marker the update left behind (it's done, failed, or long gone) is removed.
pub fn in_progress(dir: &Path, own: &str) -> Option<String> {
    let path = dir.join(MARKER);
    let marker = std::fs::read(&path).ok().and_then(|b| serde_json::from_slice::<Marker>(&b).ok())?;
    let state = still_installing(&marker, own, now(), installer_running());
    if state.is_none() {
        let _ = std::fs::remove_file(&path);
    }
    state
}

/// While the installer runs, every copy waits. Before it shows up, only the old version does:
/// the new one starting with no installer around means the install is over.
fn still_installing(marker: &Marker, own: &str, now: i64, installer_running: bool) -> Option<String> {
    let age = now - marker.at;
    let starting = own != marker.version && age < STARTING;
    (age < MARKER_TTL && (installer_running || starting)).then(|| marker.version.clone())
}

/// The updater saves the installer as `Mantel-<version>-installer.exe`.
fn is_installer(process: &str) -> bool {
    let name = process.to_lowercase();
    name.starts_with("mantel-") && name.ends_with("-installer.exe")
}

fn installer_running() -> bool {
    use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    sys.processes().values().any(|p| is_installer(&p.name().to_string_lossy()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn knows_the_updaters_installer() {
        assert!(is_installer("Mantel-0.5.1-installer.exe"));
        assert!(is_installer("mantel-0.5.1-test.2-installer.exe"));
        assert!(!is_installer("Mantel.exe"));
        assert!(!is_installer("Mantel_0.5.1_x64-setup.exe"));
    }

    #[test]
    fn every_copy_waits_while_the_installer_runs() {
        let marker = Marker { version: "0.5.1".into(), at: 1_000 };
        assert_eq!(still_installing(&marker, "0.5.0", 1_090, true).as_deref(), Some("0.5.1"));
        // The new copy, opened before the installer registered the package and closed it.
        assert_eq!(still_installing(&marker, "0.5.1", 1_090, true).as_deref(), Some("0.5.1"));
        // A marker from long ago, whatever runs now.
        assert_eq!(still_installing(&marker, "0.5.0", 1_000 + MARKER_TTL, true), None);
    }

    #[test]
    fn the_old_version_waits_for_the_installer_to_show_up() {
        let marker = Marker { version: "0.5.1".into(), at: 1_000 };
        // Xbox mode opened it while Windows was still checking the installer.
        assert_eq!(still_installing(&marker, "0.5.0", 1_004, false).as_deref(), Some("0.5.1"));
        // It never came: the update failed, so this copy starts up.
        assert_eq!(still_installing(&marker, "0.5.0", 1_000 + STARTING, false), None);
    }

    #[test]
    fn the_new_version_without_an_installer_means_done() {
        let marker = Marker { version: "0.5.1".into(), at: 1_000 };
        assert_eq!(still_installing(&marker, "0.5.1", 1_012, false), None);
    }

    #[test]
    fn markers_are_kept_while_needed_and_cleared_after() {
        let dir = std::env::temp_dir().join(format!("mantel-update-{}", std::process::id()));
        begin(&dir, "0.5.1");
        assert!(dir.join(MARKER).is_file());
        // No installer runs while the tests do: the old version waits for one to start.
        assert_eq!(in_progress(&dir, "0.5.0").as_deref(), Some("0.5.1"));
        assert!(dir.join(MARKER).is_file());
        // The new version is up: the update is over.
        assert_eq!(in_progress(&dir, "0.5.1"), None);
        assert!(!dir.join(MARKER).exists());
        // An update that didn't start.
        begin(&dir, "0.5.1");
        end(&dir);
        assert_eq!(in_progress(&dir, "0.5.0"), None);
        std::fs::remove_dir_all(&dir).ok();
    }
}
