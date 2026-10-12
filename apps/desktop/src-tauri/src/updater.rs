//! In-app update check.
//!
//! The web client stays Tauri-free (CLAUDE.md §4), so the shell owns updates: once the
//! server is up it asks the R2 manifest (`plugins.updater` in `tauri.conf.json`) on launch
//! and every 6 hours whether a newer build exists and, if the user agrees, downloads
//! (progress on the splash), installs and relaunches. Everything is best-effort — a missing
//! network or an unreachable manifest must never keep the app from running.

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

use crate::server_supervisor::Supervisor;

const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

/// One loop per process — the supervisor calls this again after every server restart.
static STARTED: AtomicBool = AtomicBool::new(false);

/// Starts the periodic check on its own thread; returns immediately.
pub fn check_on_launch(app: AppHandle) {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        let mut declined: Option<String> = None;
        loop {
            if let Err(err) = check(&app, &mut declined) {
                eprintln!("[tide-shell] update check skipped: {err}");
            }
            std::thread::sleep(CHECK_EVERY);
        }
    });
}

fn check(app: &AppHandle, declined: &mut Option<String>) -> Result<(), Box<dyn std::error::Error>> {
    let Some(update) = tauri::async_runtime::block_on(app.updater()?.check())? else {
        return Ok(()); // already current
    };
    if declined.as_deref() == Some(update.version.as_str()) {
        return Ok(()); // asked already; don't nag every 6 hours
    }
    let accepted = app
        .dialog()
        .message(format!("Tide {} is available — Install and relaunch?", update.version))
        .title("Update available")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom("Install".into(), "Later".into()))
        .blocking_show();
    if !accepted {
        *declined = Some(update.version.clone());
        return Ok(());
    }

    let sup = app.state::<Supervisor>();
    sup.show_splash("updating", format!("Downloading Tide {}…", update.version));
    let (mut done, mut last_pct) = (0u64, 0u64);
    let version = update.version.clone();
    let progress = app.clone();
    let result = tauri::async_runtime::block_on(update.download_and_install(
        move |chunk, total| {
            done += chunk as u64;
            let pct = total.map_or(0, |t| done * 100 / t.max(1));
            if pct != last_pct {
                last_pct = pct;
                progress.state::<Supervisor>().show_splash("updating", format!("Downloading Tide {version}… {pct}%"));
            }
        },
        || {},
    ));
    if let Err(err) = result {
        sup.reopen();
        return Err(err.into());
    }
    // `restart()` skips `RunEvent::Exit`, so stop the server group ourselves first.
    sup.shutdown();
    app.restart();
}
