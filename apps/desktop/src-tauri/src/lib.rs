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
                _ => ("text/html; charset=utf-8", LOADING_HTML.as_bytes().to_vec()),
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
        // Closing the only window quits the app, which runs the Exit branch below.
        RunEvent::WindowEvent { event: WindowEvent::Destroyed, .. } => handle.exit(0),
        RunEvent::Exit => {
            if let Some(sup) = handle.try_state::<Supervisor>() {
                sup.shutdown();
            }
        }
        _ => {}
    });
}

/// The one command the web app would need if it ever asked instead of reading the URL.
#[tauri::command]
fn server_endpoint(sup: tauri::State<'_, Supervisor>) -> Result<server_supervisor::Endpoint, String> {
    sup.endpoint().ok_or_else(|| "server not ready".to_string())
}
