//! The splash page's `tide-shell://localhost/…` mini-API, which picks the server the window
//! shows (`shell.json`, see `shell_config`). On macOS the app menu carries "Connect to another
//! machine…" and "Run the local server"; on Windows/Linux there is no app menu and the same two
//! actions are reached from the web app's Settings, which navigates to this splash with
//! `?connect=1` / `?local=1`.

use tauri::http::{Request, Response};
use tauri::{Manager, Runtime, UriSchemeContext};

use crate::launcher::tide_home;
use crate::server_supervisor::{Supervisor, LOADING_HTML};
use crate::shell_config::{self, Mode, Remote, ShellConfig};
use crate::splash_theme;

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, req: Request<Vec<u8>>) -> Response<Vec<u8>> {
    let app = ctx.app_handle();
    let sup = app.try_state::<Supervisor>();
    let (status, mime, body): (u16, &str, Vec<u8>) = match req.uri().path() {
        "/status" => (200, "application/json", sup.map(|s| s.status()).and_then(|s| serde_json::to_vec(&s).ok()).unwrap_or_default()),
        "/retry" => outcome(sup.as_deref(), Ok(())),
        "/reopen" => {
            if let Some(s) = sup {
                s.reopen();
            }
            (200, "text/plain", Vec::new())
        }
        // "Use that server": reuse the server that already holds TIDE_HOME
        "/attach" => outcome(sup.as_deref(), tide_home().and_then(|home| shell_config::set_mode(&home, Mode::Attach))),
        // "Run the local server" (`?local=1`, from the web app's Settings)
        "/local" => {
            let mode = tide_home().map(|home| shell_config::load(&home).mode).unwrap_or_default();
            if keep_running_local(mode, sup.as_deref().is_some_and(Supervisor::local_server_running)) {
                // Already on a healthy local server: just go back to it. Off this handler's
                // thread so the page's fetch completes before the window navigates.
                let handle = app.clone();
                std::thread::spawn(move || {
                    if let Some(s) = handle.try_state::<Supervisor>() {
                        s.reopen();
                    }
                });
                (200, "text/plain", Vec::new())
            } else {
                outcome(sup.as_deref(), tide_home().and_then(|home| shell_config::set_mode(&home, Mode::Local)))
            }
        }
        // the splash paired with another machine itself and hands over `{url, token, clientId?}`
        "/remote" => outcome(sup.as_deref(), save_remote(req.body())),
        _ => {
            // Whoever navigated here (the shell, or the web app by itself), the window has left
            // the web app, so the next `open_web_app` must navigate. Only the page itself counts:
            // a stray sub-request (favicon) may land after the window is already on the app.
            if let Some(s) = sup.as_deref().filter(|_| req.uri().path() == "/") {
                s.left_app();
            }
            let version = app.package_info().version.to_string();
            let theme = splash_theme::resolve(tide_home().ok().as_deref(), req.uri().query());
            let html = LOADING_HTML.replace("__TIDE_VERSION__", &version).replace("__TIDE_THEME__", theme);
            (200, "text/html; charset=utf-8", html.into_bytes())
        }
    };
    Response::builder().status(status).header("Content-Type", mime).body(body).expect("static response")
}

/// `/local` with the shell already running its own healthy server: no restart, just reopen.
fn keep_running_local(mode: Mode, local_running: bool) -> bool {
    mode == Mode::Local && local_running
}

/// A saved mode change wakes the supervisor; a failed one is reported to the splash.
fn outcome(sup: Option<&Supervisor>, saved: Result<(), String>) -> (u16, &'static str, Vec<u8>) {
    match saved {
        Ok(()) => {
            if let Some(s) = sup {
                s.retry();
            }
            (200, "text/plain", Vec::new())
        }
        Err(err) => (400, "text/plain", err.into_bytes()),
    }
}

fn save_remote(body: &[u8]) -> Result<(), String> {
    let remote: Remote = serde_json::from_slice(body).map_err(|e| format!("bad request: {e}"))?;
    shell_config::ws_url_for(&remote.url)?;
    if remote.token.is_empty() {
        return Err("no token".into());
    }
    shell_config::save(&tide_home()?, &ShellConfig { mode: Mode::Remote, remote: Some(remote) })
}

/// The macOS app menu (the system menu bar). Not installed on Windows/Linux, where Tauri
/// would draw it as a row inside the window.
#[cfg(target_os = "macos")]
pub mod menu {
    use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
    use tauri::{AppHandle, Manager, Runtime};

    use crate::launcher::tide_home;
    use crate::server_supervisor::Supervisor;
    use crate::shell_config::{self, Mode};

    const MENU_CONNECT: &str = "tide-connect";
    const MENU_LOCAL: &str = "tide-local";

    /// The platform default menu plus our two entries at the end of its first (app) submenu.
    pub fn install<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
        let menu = Menu::default(app)?;
        let connect = MenuItem::with_id(app, MENU_CONNECT, "Connect to another machine…", true, None::<&str>)?;
        let local = MenuItem::with_id(app, MENU_LOCAL, "Run the local server", true, None::<&str>)?;
        let sep = PredefinedMenuItem::separator(app)?;
        if let Some(MenuItemKind::Submenu(first)) = menu.items()?.into_iter().next() {
            first.append_items(&[&sep, &connect, &local])?;
        } else {
            menu.append_items(&[&connect, &local])?;
        }
        app.set_menu(menu)?;
        app.on_menu_event(|app, event| {
            let Some(sup) = app.try_state::<Supervisor>() else { return };
            match event.id().as_ref() {
                MENU_CONNECT => sup.show_connect(),
                MENU_LOCAL => match tide_home().and_then(|home| shell_config::set_mode(&home, Mode::Local)) {
                    Ok(()) => sup.retry(),
                    Err(err) => eprintln!("[tide-shell] cannot switch to the local server: {err}"),
                },
                _ => {}
            }
        });
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_only_skips_the_restart_for_a_running_local_server() {
        assert!(keep_running_local(Mode::Local, true));
        assert!(!keep_running_local(Mode::Local, false));
        assert!(!keep_running_local(Mode::Attach, true));
        assert!(!keep_running_local(Mode::Remote, false));
    }
}
