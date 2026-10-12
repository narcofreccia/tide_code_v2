//! Supervises the `tide-server` process and hands its endpoint to the web app.
//!
//! Lifecycle: resolve a binary -> pick a loopback port (once per app run) -> spawn in its own
//! process group -> poll `/health` -> read `TIDE_HOME/server.json` -> navigate the window to
//! the web app. A crash restarts on the same port with exponential backoff; the webview is
//! only re-navigated when the URL changes, otherwise the web client's own WS reconnect
//! picks the server back up. Too many starts in a short window stops and shows a Retry.

use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::Path;
use std::process::Child;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use crate::launcher::{free_port, resolve_launcher, tide_home};
use crate::process::{self, LogSink};

/// The splash page, embedded so it works identically in dev and in the bundle.
pub const LOADING_HTML: &str = include_str!("../../loading.html");
pub const SPLASH_URL: &str = "tide-shell://localhost/";

const STATUS_EVENT: &str = "tide://server-status";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_INTERVAL: Duration = Duration::from_millis(100);
const BACKOFF_MIN: Duration = Duration::from_secs(1);
const BACKOFF_MAX: Duration = Duration::from_secs(30);
/// Up for this long counts as stable: the next crash starts from the minimum backoff again.
const STABLE_AFTER: Duration = Duration::from_secs(60);
const RESTART_WINDOW: Duration = Duration::from_secs(120);
const MAX_STARTS_IN_WINDOW: usize = 5;

#[derive(Clone, Serialize)]
pub struct Endpoint {
    pub url: String,
    pub token: String,
    #[serde(rename = "environmentId")]
    pub environment_id: String,
}

#[derive(Clone, Serialize, Default)]
pub struct Status {
    pub state: String,
    pub message: Option<String>,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    endpoint: Option<Endpoint>,
    stopping: bool,
    retry: bool,
    status: Status,
    /// The web-app URL the webview was last pointed at; `None` while the splash is showing.
    navigated: Option<String>,
}

type Shared = Arc<Mutex<Inner>>;

pub struct Supervisor {
    app: AppHandle,
    inner: Shared,
}

impl Supervisor {
    /// Spawns the supervision loop on a plain OS thread and returns immediately.
    pub fn start(app: AppHandle) -> Self {
        let inner: Shared = Arc::default();
        let (worker, handle) = (Arc::clone(&inner), app.clone());
        std::thread::Builder::new()
            .name("tide-server-supervisor".into())
            .spawn(move || supervise(handle, worker))
            .expect("spawn supervisor thread");
        Self { app, inner }
    }

    pub fn endpoint(&self) -> Option<Endpoint> {
        self.inner.lock().ok()?.endpoint.clone()
    }

    pub fn status(&self) -> Status {
        self.inner.lock().map(|i| i.status.clone()).unwrap_or_default()
    }

    /// Splash "Retry" button: lets a gave-up supervisor start over.
    pub fn retry(&self) {
        if let Ok(mut i) = self.inner.lock() {
            i.retry = true;
        }
    }

    /// Updater hook: put the splash back on screen with a message.
    pub fn show_splash(&self, state: &str, message: String) {
        show_splash(&self.app, &self.inner);
        set_status(&self.app, &self.inner, state, Some(message));
    }

    /// Updater hook: return to the web app after a failed update.
    pub fn reopen(&self) {
        if let Some(ep) = self.endpoint() {
            open_web_app(&self.app, &self.inner, &ep);
        }
    }

    /// Idempotent: stops the restart loop, then SIGTERM -> 5 s -> SIGKILL on the group.
    pub fn shutdown(&self) {
        let child = {
            let Ok(mut i) = self.inner.lock() else { return };
            i.stopping = true;
            i.endpoint = None;
            i.child.take()
        };
        if let Some(mut child) = child {
            process::stop(&mut child);
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn stopping(inner: &Shared) -> bool {
    inner.lock().map(|i| i.stopping).unwrap_or(true)
}

/// One-shot `GET /health`; `true` once the server answers `{"ok":true,...}`.
fn health_ok(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    if stream.write_all(b"GET /health HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() {
        return false;
    }
    let mut body = String::new();
    let _ = stream.read_to_string(&mut body);
    body.contains("\"ok\":true")
}

/// `server.json` is written by the server on first boot, so it is only read after `/health`.
fn read_identity(home: &Path) -> Result<(String, String), String> {
    let raw = std::fs::read_to_string(home.join("server.json")).map_err(|e| format!("server.json: {e}"))?;
    let parsed: serde_json::Value = serde_json::from_str(&raw).map_err(|e| format!("server.json: {e}"))?;
    let token = parsed.get("token").and_then(|v| v.as_str()).ok_or("server.json has no token")?;
    let env_id = parsed.get("environmentId").and_then(|v| v.as_str()).unwrap_or_default();
    Ok((token.to_string(), env_id.to_string()))
}

fn supervise(app: AppHandle, inner: Shared) {
    let mut port: Option<u16> = None;
    let mut starts: VecDeque<Instant> = VecDeque::new();
    let mut backoff = BACKOFF_MIN;
    let mut first = true;

    loop {
        if stopping(&inner) {
            return;
        }
        let now = Instant::now();
        starts.retain(|t| now.duration_since(*t) < RESTART_WINDOW);
        if starts.len() >= MAX_STARTS_IN_WINDOW {
            let msg = format!(
                "the server stopped {MAX_STARTS_IN_WINDOW} times within {}s.\nSee TIDE_HOME/logs/server.log.",
                RESTART_WINDOW.as_secs()
            );
            show_splash(&app, &inner);
            set_status(&app, &inner, "failed", Some(msg));
            if !wait_retry(&inner) {
                return;
            }
            starts.clear();
            backoff = BACKOFF_MIN;
        }
        starts.push_back(now);
        set_status(&app, &inner, if first { "starting" } else { "restarting" }, None);
        first = false;

        let reason = match boot(&app, &inner, &mut port) {
            Ok(started_at) => {
                let code = wait_for_exit(&inner);
                if stopping(&inner) {
                    return;
                }
                if started_at.elapsed() >= STABLE_AFTER {
                    backoff = BACKOFF_MIN;
                }
                format!("server exited ({code})")
            }
            Err(err) => {
                port = None; // most likely a bind race: try another port next time
                err
            }
        };
        set_status(&app, &inner, "restarting", Some(format!("{reason}; restarting in {}s", backoff.as_secs())));
        if !sleep_unless_stopping(&inner, backoff) {
            return;
        }
        backoff = (backoff * 2).min(BACKOFF_MAX);
    }
}

fn sleep_unless_stopping(inner: &Shared, total: Duration) -> bool {
    let end = Instant::now() + total;
    while Instant::now() < end {
        if stopping(inner) {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    !stopping(inner)
}

/// Blocks until the splash's Retry is pressed; `false` when the app is quitting instead.
fn wait_retry(inner: &Shared) -> bool {
    loop {
        {
            let Ok(mut i) = inner.lock() else { return false };
            if i.stopping {
                return false;
            }
            if std::mem::take(&mut i.retry) {
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Spawns one server generation and blocks until it is healthy and the webview points at it.
fn boot(app: &AppHandle, inner: &Shared, port: &mut Option<u16>) -> Result<Instant, String> {
    let launcher = resolve_launcher()?;
    let home = tide_home()?;
    let port_no = match *port {
        Some(p) => p,
        None => *port.insert(free_port()?),
    };
    let sink = LogSink::open(&home).map_err(|e| format!("cannot open the server log: {e}"))?;

    let mut cmd = launcher.command();
    cmd.arg("--port").arg(port_no.to_string()).arg("--host").arg("127.0.0.1").env("TIDE_HOME", &home);
    if tauri::is_dev() {
        // Dev also accepts `?token=` on the websocket, which is what we hand the web app.
        cmd.arg("--dev");
    }
    if let crate::launcher::Launcher::Node { entry, .. } = &launcher {
        if let Some(repo) = entry.ancestors().nth(4) {
            cmd.current_dir(repo);
        }
    }

    let child = process::spawn(&mut cmd, &sink, tauri::is_dev())
        .map_err(|e| format!("cannot start {}: {e}", launcher.describe()))?;
    let started_at = Instant::now();
    inner.lock().map_err(|_| "supervisor poisoned")?.child = Some(child);

    let deadline = Instant::now() + HEALTH_TIMEOUT;
    while Instant::now() < deadline {
        if exited(inner) {
            return Err(format!("{} exited before becoming healthy (port {port_no})", launcher.describe()));
        }
        if health_ok(port_no) {
            let (token, environment_id) = read_identity(&home)?;
            let endpoint = Endpoint { url: format!("ws://127.0.0.1:{port_no}/ws"), token, environment_id };
            inner.lock().map_err(|_| "supervisor poisoned")?.endpoint = Some(endpoint.clone());
            set_status(app, inner, "ready", Some(format!("connected to {}", endpoint.url)));
            open_web_app(app, inner, &endpoint);
            // The app is usable now — look for a newer release without blocking it.
            crate::updater::check_on_launch(app.clone());
            return Ok(started_at);
        }
        std::thread::sleep(HEALTH_INTERVAL);
    }
    take_and_stop(inner);
    Err(format!("{} did not answer /health within {}s", launcher.describe(), HEALTH_TIMEOUT.as_secs()))
}

fn take_and_stop(inner: &Shared) {
    let child = inner.lock().ok().and_then(|mut i| i.child.take());
    if let Some(mut child) = child {
        process::stop(&mut child);
    }
}

fn exited(inner: &Shared) -> bool {
    let Ok(mut guard) = inner.lock() else { return true };
    match guard.child.as_mut() {
        Some(child) => !matches!(child.try_wait(), Ok(None)),
        None => true,
    }
}

/// Polls the child rather than holding the mutex across `wait()`, so `shutdown()` can win.
fn wait_for_exit(inner: &Shared) -> String {
    loop {
        {
            let Ok(mut guard) = inner.lock() else { return "supervisor poisoned".into() };
            if guard.stopping {
                return "stopping".into();
            }
            match guard.child.as_mut().map(|c| c.try_wait()) {
                None => return "no child".into(),
                Some(Ok(Some(st))) => {
                    guard.child = None;
                    guard.endpoint = None;
                    return st.code().map_or_else(|| "signal".to_string(), |c| format!("code {c}"));
                }
                Some(Err(e)) => return e.to_string(),
                Some(Ok(None)) => {}
            }
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

fn set_status(app: &AppHandle, inner: &Shared, state: &str, message: Option<String>) {
    let payload = Status { state: state.into(), message: message.clone() };
    if let Ok(mut i) = inner.lock() {
        i.status = payload.clone();
    }
    eprintln!("[tide-shell] {state}: {}", payload.message.as_deref().unwrap_or(""));
    let _ = app.emit(STATUS_EVENT, &payload);
    // The splash page has no ACL of its own, so push the text into it directly (a no-op
    // once the window shows the web app, which has no `__tideStatus`).
    if let Some(win) = app.get_webview_window("main") {
        let text = serde_json::to_string(&message.unwrap_or_else(|| state.to_string())).unwrap_or_else(|_| "\"\"".into());
        let _ = win.eval(format!("window.__tideStatus && window.__tideStatus(\"{state}\", {text})"));
    }
}

fn show_splash(app: &AppHandle, inner: &Shared) {
    let was_app = inner.lock().map(|mut i| i.navigated.take().is_some()).unwrap_or(false);
    if was_app {
        if let (Some(win), Ok(url)) = (app.get_webview_window("main"), SPLASH_URL.parse()) {
            let _ = win.navigate(url);
        }
    }
}

/// The web app never imports Tauri: it learns the endpoint from its own query string.
/// Skipped when the webview already shows this exact URL — its WS client reconnects itself.
fn open_web_app(app: &AppHandle, inner: &Shared, endpoint: &Endpoint) {
    let base = if tauri::is_dev() { "http://localhost:5173" } else { "tauri://localhost" };
    let target = format!("{base}/?token={}&server={}", urlencode(&endpoint.token), urlencode(&endpoint.url));
    if inner.lock().map(|i| i.navigated.as_deref() == Some(target.as_str())).unwrap_or(false) {
        eprintln!("[tide-shell] webview already on the app URL; not navigating");
        return;
    }
    let Some(win) = app.get_webview_window("main") else { return };
    match target.parse() {
        Ok(url) => {
            let _ = win.navigate(url);
            if let Ok(mut i) = inner.lock() {
                i.navigated = Some(target);
            }
        }
        Err(e) => set_status(app, inner, "failed", Some(format!("bad web app url {target}: {e}"))),
    }
}

fn urlencode(raw: &str) -> String {
    raw.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}
