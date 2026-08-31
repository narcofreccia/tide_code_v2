//! In-app update check.
//!
//! The web client stays Tauri-free (CLAUDE.md §4), so the shell owns updates: once the
//! server is up it asks the R2 manifest (`plugins.updater` in `tauri.conf.json`) whether a
//! newer build exists and, if the user agrees, downloads, installs and relaunches.
//! Everything here is best-effort — a missing network or an unreachable manifest must
//! never keep the app from starting.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// One check per process — the supervisor calls this again after every server restart.
static CHECKED: AtomicBool = AtomicBool::new(false);

/// Spawns the check on a background task; returns immediately.
///
/// Called once the server is ready so the update prompt never competes with the splash.
pub fn check_on_launch(app: AppHandle) {
    if CHECKED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        if let Err(err) = check(&app).await {
            log_skip(&err.to_string());
        }
    });
}

async fn check(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let Some(update) = app.updater()?.check().await? else {
        return Ok(()); // already current
    };

    let version = update.version.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .message(format!(
            "Tide {version} is available — Install and relaunch?"
        ))
        .title("Update available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Install".into(),
            "Later".into(),
        ))
        .show(move |accepted| {
            let _ = tx.send(accepted);
        });

    if !rx.recv().unwrap_or(false) {
        return Ok(());
    }

    update.download_and_install(|_, _| {}, || {}).await?;
    app.restart();
}

fn log_skip(reason: &str) {
    eprintln!("[tide-shell] update check skipped: {reason}");
}
