//! The splash page's `tide-shell://localhost/…` mini-API and the app-menu entries that pick
//! which server the window shows (`shell.json`, see `shell_config`).

use tauri::http::{Request, Response};
use tauri::menu::{Menu, MenuItem, MenuItemKind, PredefinedMenuItem};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext};

use crate::launcher::tide_home;
use crate::server_supervisor::{Supervisor, LOADING_HTML};
use crate::shell_config::{self, Mode, Remote, ShellConfig};
use crate::splash_theme;

const MENU_CONNECT: &str = "tide-connect";
const MENU_LOCAL: &str = "tide-local";

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
        // the splash paired with another machine itself and hands over `{url, token, clientId?}`
        "/remote" => outcome(sup.as_deref(), save_remote(req.body())),
        _ => {
            let version = app.package_info().version.to_string();
            let theme = splash_theme::resolve(tide_home().ok().as_deref(), req.uri().query());
            let html = LOADING_HTML.replace("__TIDE_VERSION__", &version).replace("__TIDE_THEME__", theme);
            (200, "text/html; charset=utf-8", html.into_bytes())
        }
    };
    Response::builder().status(status).header("Content-Type", mime).body(body).expect("static response")
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

/// The platform default menu plus our two entries at the end of its first (app) submenu.
pub fn install_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
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
