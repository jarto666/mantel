//! A plain append-only log in the app data folder, readable over SSH while debugging.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static FILE: OnceLock<PathBuf> = OnceLock::new();
static LOCK: Mutex<()> = Mutex::new(());
const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// `version` is the app's (package.json), not the crate's.
pub fn init(dir: &std::path::Path, version: &str) {
    let path = dir.join("mantel.log");
    // Keep one previous log around instead of growing forever.
    if fs::metadata(&path).is_ok_and(|m| m.len() > MAX_BYTES) {
        let _ = fs::rename(&path, dir.join("mantel.old.log"));
    }
    let _ = FILE.set(path);
    info(&format!("--- Mantel {version} started ---"));
}

pub fn write(level: &str, msg: &str) {
    let Some(path) = FILE.get() else { return };
    let _guard = LOCK.lock();
    let ts = crate::model::now();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{ts} {level:<5} {msg}");
    }
}

pub fn info(msg: &str) {
    write("INFO", msg);
}

pub fn warn(msg: &str) {
    write("WARN", msg);
}
