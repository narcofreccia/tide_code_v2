//! Tide desktop shell.
//!
//! The shell holds no business logic: it supervises the `tide-server` sidecar and points
//! the webview at `apps/web` with the server's endpoint in the query string. Everything
//! else — orchestration, providers, git, files — lives in the server.

mod server_supervisor;
mod updater;

use server_supervisor::{Supervisor, LOADING_HTML};
use tauri::{Manager, RunEvent, WindowEvent};

/// Serves the desktop-only splash page; `tauri.conf.json` points the main window here
/// until the server is ready. It is its own scheme so it never collides with the web app.
const LOADING_SCHEME: &str = "tide-shell";

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .register_uri_scheme_protocol(LOADING_SCHEME, |_ctx, _req| {
            tauri::http::Response::builder()
                .header("Content-Type", "text/html; charset=utf-8")
                .body(LOADING_HTML.as_bytes().to_vec())
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
        RunEvent::WindowEvent {
            event: WindowEvent::Destroyed,
            ..
        }
        | RunEvent::ExitRequested { .. }
        | RunEvent::Exit => {
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
