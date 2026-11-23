//! `POST tide-shell://localhost/window/{minimize,toggle-maximize,close}`: the window buttons
//! of the web app's top bar and of the splash on Windows, where the main window has no native
//! title bar. The web app reaches them with a plain `fetch` to the shell's origin, so it never
//! imports Tauri.

use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowAction {
    Minimize,
    ToggleMaximize,
    Close,
}

/// The action a `/window/…` request asks for, or the HTTP status that refuses it. Only POST
/// acts, so a prefetch or a stray GET can never minimise or close the window.
pub fn route(method: &str, path: &str) -> Result<WindowAction, u16> {
    let action = match path.strip_prefix("/window/") {
        Some("minimize") => WindowAction::Minimize,
        Some("toggle-maximize") => WindowAction::ToggleMaximize,
        Some("close") => WindowAction::Close,
        _ => return Err(404),
    };
    if method.eq_ignore_ascii_case("POST") {
        Ok(action)
    } else {
        Err(405)
    }
}

/// Runs the action on the main window, off the scheme handler's thread: the page's request
/// completes first, and a close goes through `CloseRequested` like the native button, so the
/// shell's graceful close (`close_gracefully` in `lib.rs`) stops the server before exiting.
pub fn perform<R: Runtime>(app: &AppHandle<R>, action: WindowAction) {
    let app = app.clone();
    std::thread::spawn(move || {
        let Some(win) = app.get_webview_window("main") else { return };
        let done = match action {
            WindowAction::Minimize => win.minimize(),
            WindowAction::ToggleMaximize => match win.is_maximized() {
                Ok(true) => win.unmaximize(),
                _ => win.maximize(),
            },
            WindowAction::Close => win.close(),
        };
        if let Err(err) = done {
            eprintln!("[tide-shell] window {action:?}: {err}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn posts_map_to_actions() {
        assert_eq!(route("POST", "/window/minimize"), Ok(WindowAction::Minimize));
        assert_eq!(route("POST", "/window/toggle-maximize"), Ok(WindowAction::ToggleMaximize));
        assert_eq!(route("post", "/window/close"), Ok(WindowAction::Close));
    }

    #[test]
    fn other_methods_are_refused() {
        assert_eq!(route("GET", "/window/close"), Err(405));
        assert_eq!(route("HEAD", "/window/minimize"), Err(405));
    }

    #[test]
    fn unknown_paths_are_not_found() {
        assert_eq!(route("POST", "/window/maximize"), Err(404));
        assert_eq!(route("POST", "/window/"), Err(404));
        assert_eq!(route("POST", "/window/close/extra"), Err(404));
        assert_eq!(route("POST", "/status"), Err(404));
    }
}
