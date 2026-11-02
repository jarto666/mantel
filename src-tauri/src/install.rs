//! Installing Store games from inside Mantel through Windows' own installer (AppInstallManager,
//! what the Microsoft Store and the Xbox app use), so Game Pass games install on the player's
//! subscription without either. The windows crate leaves that WinRT namespace out, so a hidden
//! PowerShell drives it and reports progress as lines on stdout.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// The game's id in Mantel.
    pub id: String,
    /// "pending", "downloading", "installing", "paused", "done", "canceled" or "error".
    pub state: String,
    pub percent: f32,
    /// Bytes so far and in all; 0 until Windows knows.
    pub downloaded: u64,
    pub total: u64,
    pub error: Option<String>,
}

/// Installs Mantel started or follows, by game id; finished ones drop out.
static ACTIVE: Mutex<Vec<Progress>> = Mutex::new(Vec::new());

/// Prints "<state> <percent> <downloaded> <total>" every moment until the install ends, or
/// "error <hresult> <message>". A bundle installs as several packages, reported as one.
/// An install already under way (from the Store, the Xbox app or an earlier run) is followed,
/// not started again.
#[cfg(windows)]
const INSTALL: &str = r#"
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
  [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager, Windows.ApplicationModel.Store.Preview, ContentType = WindowsRuntime] | Out-Null
  [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallOptions, Windows.ApplicationModel.Store.Preview, ContentType = WindowsRuntime] | Out-Null
  $targets = {targets}
  $packages = {packages}
  $m = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager]::new()
  $items = @(@($m.AppInstallItems) | Where-Object { $packages -contains $_.ProductId })
  if (-not $items) {
    $list = [System.Collections.Generic.IReadOnlyList[Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallItem]]
    $items = @(foreach ($target in $targets) {
      try { Await ($m.StartProductInstallAsync($target, '', 'Mantel', '', [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallOptions]::new())) $list }
      catch { Await ($m.StartAppInstallAsync($target, '', $false, $false)) ([Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallItem]) }
    })
  }
  if (-not $items) { 'error 0 Windows has nothing to install for this game'; exit }
  while ($true) {
    $all = @($items | ForEach-Object { $_.GetCurrentStatus() })
    $failed = @($all | Where-Object { "$($_.InstallState)" -eq 'Error' })
    if ($failed) { 'error {0:X8} {1}' -f $failed[0].ErrorCode.HResult, $failed[0].ErrorCode.Message; exit }
    $states = @($all | ForEach-Object { "$($_.InstallState)" })
    $active = @($states | Where-Object { $_ -notin 'Completed', 'Canceled' })
    $state = if ($active -contains 'Downloading') { 'Downloading' } elseif ($active) { $active[0] } elseif ($states -contains 'Canceled') { 'Canceled' } else { 'Completed' }
    # Windows says 1 until it knows a package's size.
    $sized = @($all | Where-Object { $_.DownloadSizeInBytes -gt 1 })
    [uint64]$done = 0; [uint64]$total = 0; [double]$weighted = 0
    foreach ($s in $sized) { $done += $s.BytesDownloaded; $total += $s.DownloadSizeInBytes; $weighted += $s.PercentComplete * $s.DownloadSizeInBytes }
    $percent = if ($total) { $weighted / $total } else { ($all | Measure-Object PercentComplete -Average).Average }
    # Invariant: a Windows set to French or Russian writes 34,5.
    '{0} {1} {2} {3}' -f $state, ([double]$percent).ToString('0.0', [cultureinfo]::InvariantCulture), $done, $total
    if (-not $active) { exit }
    Start-Sleep -Milliseconds 700
  }
} catch {
  'error 0 {0}' -f $(if ($_.Exception.InnerException) { $_.Exception.InnerException.Message } else { $_.Exception.Message })
}
"#;

#[cfg(windows)]
const CANCEL: &str = r#"
[Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager, Windows.ApplicationModel.Store.Preview, ContentType = WindowsRuntime] | Out-Null
$m = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager]::new()
$packages = {packages}
$items = @(@($m.AppInstallItems) | Where-Object { $packages -contains $_.ProductId })
$items | ForEach-Object { $_.Cancel() }
$items.Count
"#;

/// Prints the product id of every install under way, whoever started it.
#[cfg(windows)]
const UNDER_WAY: &str = r#"
[Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager, Windows.ApplicationModel.Store.Preview, ContentType = WindowsRuntime] | Out-Null
$m = [Windows.ApplicationModel.Store.Preview.InstallControl.AppInstallManager]::new()
@($m.AppInstallItems) | Where-Object { "$($_.GetCurrentStatus().InstallState)" -notin 'Completed', 'Canceled', 'Error' } | ForEach-Object { $_.ProductId }
"#;

/// Prints True or False, or nothing when the Store can't say.
#[cfg(windows)]
const ON_ACCOUNT: &str = r#"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
[Windows.Services.Store.StoreContext, Windows.Services.Store, ContentType = WindowsRuntime] | Out-Null
[Windows.Services.Store.StoreProductQueryResult, Windows.Services.Store, ContentType = WindowsRuntime] | Out-Null
$op = [Windows.Services.Store.StoreContext]::GetDefault().GetStoreProductsAsync([string[]]@('Game', 'Application'), [string[]]@('{product}'))
$task = $asTask.MakeGenericMethod([Windows.Services.Store.StoreProductQueryResult]).Invoke($null, @($op))
$task.Wait(-1) | Out-Null
foreach ($kv in $task.Result.Products) { "$($kv.Value.IsInUserCollection)" }
"#;

/// Store product ids are 12 letters and digits; anything else never reaches a script.
fn checked(product: &str) -> Result<&str, String> {
    (product.len() == 12 && product.chars().all(|c| c.is_ascii_alphanumeric())).then_some(product).ok_or_else(|| format!("Not a Store product: {product}"))
}

/// Packages as a PowerShell list, checked like the product they come from.
#[cfg_attr(not(windows), allow(dead_code))]
fn script_list(packages: &[String]) -> String {
    let quoted: Vec<String> = packages.iter().filter_map(|p| checked(p).ok()).map(|p| format!("'{p}'")).collect();
    format!("@({})", quoted.join(","))
}

/// AppInstallState names, folded into what the UI shows.
#[cfg_attr(not(windows), allow(dead_code))]
fn state_of(install_state: &str) -> &'static str {
    match install_state {
        "Downloading" => "downloading",
        "Installing" | "RestoringData" => "installing",
        "Completed" => "done",
        "Canceled" => "canceled",
        s if s.starts_with("Paused") => "paused",
        _ => "pending",
    }
}

/// A progress line: state, percent, bytes downloaded, bytes in all.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_line(line: &str) -> Option<(&str, f32, u64, u64)> {
    let mut parts = line.split_whitespace();
    Some((parts.next()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
}

#[cfg_attr(not(windows), allow(dead_code))]
pub(crate) fn publish(app: &AppHandle, p: Progress) {
    {
        let mut active = ACTIVE.lock().unwrap();
        active.retain(|a| a.id != p.id);
        if !matches!(p.state.as_str(), "done" | "canceled" | "error") {
            active.push(p.clone());
        }
    }
    let _ = app.emit("install-progress", &p);
}

pub fn active() -> Vec<Progress> {
    ACTIVE.lock().unwrap().clone()
}

#[cfg(windows)]
pub(crate) fn powershell(script: &str) -> std::process::Command {
    use base64::Engine;
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let wide: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let mut cmd = std::process::Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand"])
        .arg(base64::engine::general_purpose::STANDARD.encode(wide))
        .creation_flags(CREATE_NO_WINDOW);
    cmd
}

/// Starts installing game `id`, asking Windows for `targets` (the product, or the packages the
/// player chose), or follows it if `packages` are under way already. Reports progress as
/// "install-progress" events until it ends.
#[cfg(windows)]
pub fn start(app: &AppHandle, id: &str, targets: &[String], packages: &[String]) -> Result<(), String> {
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;
    if targets.is_empty() || targets.iter().any(|t| checked(t).is_err()) {
        return Err(format!("Not Store products: {targets:?}"));
    }
    if ACTIVE.lock().unwrap().iter().any(|a| a.id == id) {
        return Ok(());
    }
    let mut child = powershell(&INSTALL.replace("{targets}", &script_list(targets)).replace("{packages}", &script_list(packages)))
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("Couldn't start the installer: {e}"))?;
    let stdout = child.stdout.take().ok_or("no installer output")?;
    crate::log::info(&format!("install {id} ({})", targets.join(" ")));
    publish(app, Progress { id: id.to_string(), state: "pending".into(), ..Default::default() });
    let (app, id) = (app.clone(), id.to_string());
    std::thread::spawn(move || {
        let mut last = "pending".to_string();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            let line = line.trim();
            if let Some(rest) = line.strip_prefix("error ") {
                let message = rest.split_once(' ').map(|(_, m)| m.trim()).unwrap_or(rest).to_string();
                crate::log::warn(&format!("install {id}: {rest}"));
                last = "error".into();
                publish(&app, Progress { id: id.clone(), state: last.clone(), error: Some(message), ..Default::default() });
                continue;
            }
            let Some((install_state, percent, downloaded, total)) = parse_line(line) else { continue };
            let state = state_of(install_state);
            if state != last {
                crate::log::info(&format!("install {id}: {install_state}"));
            }
            last = state.to_string();
            publish(&app, Progress { id: id.clone(), state: last.clone(), percent, downloaded, total, error: None });
        }
        let _ = child.wait();
        // The script always ends on a final state; anything else means it died.
        if !matches!(last.as_str(), "done" | "canceled" | "error") {
            publish(&app, Progress { id, state: "error".into(), error: Some("The installer stopped unexpectedly".into()), ..Default::default() });
        }
    });
    Ok(())
}

#[cfg(windows)]
pub fn cancel(packages: &[String]) -> Result<(), String> {
    let out = powershell(&CANCEL.replace("{packages}", &script_list(packages))).output().map_err(|e| e.to_string())?;
    // Between pressing Install and Windows taking it on there's nothing to cancel yet.
    match String::from_utf8_lossy(&out.stdout).trim() {
        "0" => Err("Windows hasn't started this install yet. Try again in a moment.".into()),
        _ => Ok(()),
    }
}

/// Whether a product is on the account signed in to the Store: bought, or included with its Game
/// Pass. Windows downloads a game either way and only refuses it at launch, so this is the one
/// warning a player gets beforehand. One product per query: asked about in batches of a hundred,
/// a few Game Pass games on the account read false.
#[cfg(windows)]
pub fn on_account(product: &str) -> Option<bool> {
    let out = powershell(&ON_ACCOUNT.replace("{product}", checked(product).ok()?)).output().ok()?;
    match String::from_utf8_lossy(&out.stdout).trim() {
        "True" => Some(true),
        "False" => Some(false),
        _ => None,
    }
}

#[cfg(not(windows))]
pub fn on_account(_product: &str) -> Option<bool> {
    None
}

/// Product ids of the installs under way on this PC.
#[cfg(windows)]
pub fn under_way() -> Vec<String> {
    let Ok(out) = powershell(UNDER_WAY).output() else { return Vec::new() };
    String::from_utf8_lossy(&out.stdout).lines().map(str::trim).filter(|l| checked(l).is_ok()).map(String::from).collect()
}

#[cfg(not(windows))]
pub fn under_way() -> Vec<String> {
    Vec::new()
}

#[cfg(not(windows))]
pub fn start(_app: &AppHandle, _id: &str, _targets: &[String], _packages: &[String]) -> Result<(), String> {
    Err("Installing needs Windows".into())
}

#[cfg(not(windows))]
pub fn cancel(_packages: &[String]) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn checks_product_ids() {
        assert!(checked("9P7Z1D3N8KR7").is_ok());
        assert!(checked("9P7Z1D3N8KR'").is_err());
        assert!(checked("9P7Z").is_err());
    }

    #[test]
    fn lists_only_real_packages() {
        assert_eq!(script_list(&["9P5786PJB9RP".into(), "x'; evil".into(), "9PGW18NPBZV5".into()]), "@('9P5786PJB9RP','9PGW18NPBZV5')");
    }

    #[test]
    fn reads_progress_lines() {
        assert_eq!(parse_line("Downloading 34.5 1024 4096"), Some(("Downloading", 34.5, 1024, 4096)));
        assert_eq!(parse_line("Downloading 34,5 1024 4096"), None);
        assert_eq!(parse_line("True"), None);
    }

    #[test]
    fn folds_states() {
        assert_eq!(state_of("AcquiringLicense"), "pending");
        assert_eq!(state_of("PausedLowBattery"), "paused");
        assert_eq!(state_of("RestoringData"), "installing");
    }
}
