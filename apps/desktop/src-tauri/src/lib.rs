//! Tide desktop shell.
//!
//! The shell holds no business logic: it supervises the `tide-server` sidecar and points
//! the webview at `apps/web` with the server's endpoint in the query string. Everything
//! else — orchestration, providers, git, files — lives in the server.

mod launcher;
mod process;
mod server_supervisor;
mod updater;

use server_supervisor::{Supervisor, LOADING_HTML};
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, RunEvent, WindowEvent};

/// Serves the desktop-only splash page; `tauri.conf.json` points the main window here
/// until the server is ready. It is its own scheme so it never collides with the web app.
const LOADING_SCHEME: &str = "tide-shell";

pub fn run() {
    let app = tauri::Builder::default()
        // Must be first: a second launch just brings the existing window forward.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_uri_scheme_protocol(LOADING_SCHEME, |ctx, req| {
            let sup = ctx.app_handle().try_state::<Supervisor>();
            let (mime, body) = match req.uri().path() {
                "/status" => ("application/json", sup.map(|s| s.status()).and_then(|s| serde_json::to_vec(&s).ok()).unwrap_or_default()),
                "/retry" => {
                    if let Some(s) = sup {
                        s.retry();
                    }
                    ("text/plain", Vec::new())
                }
                _ => {
                    let version = ctx.app_handle().package_info().version.to_string();
                    ("text/html; charset=utf-8", LOADING_HTML.replace("__TIDE_VERSION__", &version).into_bytes())
                }
            };
            tauri::http::Response::builder()
                .header("Content-Type", mime)
                .body(body)
                .expect("static response")
        })
        .invoke_handler(tauri::generate_handler![server_endpoint])
        .setup(|app| {
            app.manage(Supervisor::start(app.handle().clone()));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the Tide shell");

    app.run(|handle, event| match event {
        // Closing the window or ⌘Q shows the closing screen while the server stops, then quits.
        RunEvent::WindowEvent { event: WindowEvent::CloseRequested { api, .. }, .. } => {
            if !CLOSING.load(Ordering::SeqCst) {
                api.prevent_close();
                close_gracefully(handle.clone());
            }
        }
        RunEvent::ExitRequested { api, .. } => {
            if !CLOSING.load(Ordering::SeqCst) {
                api.prevent_exit();
                close_gracefully(handle.clone());
            }
        }
        RunEvent::WindowEvent { event: WindowEvent::Destroyed, .. } => handle.exit(0),
        RunEvent::Exit => {
            if let Some(sup) = handle.try_state::<Supervisor>() {
                sup.shutdown();
            }
        }
        _ => {}
    });
}

static CLOSING: AtomicBool = AtomicBool::new(false);

/// Puts the boot screen back with an indeterminate bar, stops the server group, then exits.
/// The short pause lets the webview paint the screen before the stop blocks.
fn close_gracefully(handle: tauri::AppHandle) {
    if CLOSING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(sup) = handle.try_state::<Supervisor>() {
        sup.show_splash("closing", "Closing Tide…".into());
    }
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(350));
        if let Some(sup) = handle.try_state::<Supervisor>() {
            sup.shutdown();
        }
        handle.exit(0);
    });
}

/// The one command the web app would need if it ever asked instead of reading the URL.
#[tauri::command]
fn server_endpoint(sup: tauri::State<'_, Supervisor>) -> Result<server_supervisor::Endpoint, String> {
    sup.endpoint().ok_or_else(|| "server not ready".to_string())
}
