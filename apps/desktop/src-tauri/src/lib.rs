//! Tide desktop shell.
//!
//! The shell holds no business logic: it supervises the `tide-server` sidecar and points
//! the webview at `apps/web` with the server's endpoint in the query string. Everything
//! else — orchestration, providers, git, files — lives in the server.

mod launcher;
mod splash_theme;
mod process;
mod server_supervisor;
mod shell_config;
mod splash;
mod updater;
mod webview_profile;
mod window_controls;

use server_supervisor::Supervisor;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{Manager, RunEvent, WindowEvent};

/// Serves the desktop-only splash page; `tauri.conf.json` points the main window here
/// until the server is ready. It is its own scheme so it never collides with the web app.
const LOADING_SCHEME: &str = "tide-shell";

pub fn run() {
    let context = tauri::generate_context!();
    // Before the builder: windows from tauri.conf.json start WebView2 during build/setup.
    #[cfg(windows)]
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let root = std::path::Path::new(&local).join(&context.config().identifier);
        if let Err(err) = webview_profile::purge_service_workers(&root) {
            eprintln!("[tide-shell] service worker purge: {err}");
        }
    }

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
        .plugin(window_state_plugin())
        .register_uri_scheme_protocol(LOADING_SCHEME, splash::handle)
        .invoke_handler(tauri::generate_handler![server_endpoint])
        .setup(|app| {
            if let Some(win) = app.get_webview_window("main") {
                splash_theme::apply_to_window(&win, launcher::tide_home().ok().as_deref());
                // Windows: one bar. The web app's top bar is the title bar and draws the window
                // buttons (`window_controls`). tao keeps WS_CAPTION/WS_SIZEBOX and the undecorated
                // shadow on a frameless window, so edges still resize and Snap still works. Set
                // here, after the window-state plugin's restore (it runs when the window is built).
                #[cfg(windows)]
                if let Err(err) = win.set_decorations(false) {
                    eprintln!("[tide-shell] frameless window: {err}");
                }
            }
            // Windows/Linux get no app menu (Tauri would draw it inside the window); the web
            // app's Settings offers the same actions there.
            #[cfg(target_os = "macos")]
            if let Err(err) = splash::menu::install(app.handle()) {
                eprintln!("[tide-shell] menu: {err}");
            }
            app.manage(Supervisor::start(app.handle().clone()));
            Ok(())
        })
        .build(context)
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

/// Remembers size, position and maximised state. On Windows it leaves the decorations flag
/// alone: the window is made frameless in `setup`, and saving that would leave an older
/// (decorated) build without any title bar after a downgrade.
fn window_state_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    let builder = tauri_plugin_window_state::Builder::default();
    #[cfg(windows)]
    let builder = builder.with_state_flags(
        tauri_plugin_window_state::StateFlags::all() - tauri_plugin_window_state::StateFlags::DECORATIONS,
    );
    builder.build()
}

static CLOSING: AtomicBool = AtomicBool::new(false);

/// Puts the boot screen back with an indeterminate bar, stops the server group, then exits.
/// The short pause lets the webview paint the screen before the stop blocks.
fn close_gracefully(handle: tauri::AppHandle) {
    if CLOSING.swap(true, Ordering::SeqCst) {
        return;
    }
    if let Some(sup) = handle.try_state::<Supervisor>() {
        sup.show_splash("closing", "Closing Tide Code…".into());
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
