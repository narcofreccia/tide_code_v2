//! Supervises the `tide-server` process and hands its endpoint to the web app.
//!
//! Lifecycle: resolve a binary -> pick a free loopback port -> spawn -> poll `/health` ->
//! read `TIDE_HOME/server.json` for the token -> navigate the window to the web app with
//! `?token=&server=`. A crash restarts with backoff; app exit kills the child.

use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// The splash page, embedded so it works identically in dev and in the bundle.
pub const LOADING_HTML: &str = include_str!("../../loading.html");

const STATUS_EVENT: &str = "tide://server-status";
const HEALTH_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTH_INTERVAL: Duration = Duration::from_millis(100);
const BACKOFF_MIN: Duration = Duration::from_millis(500);
const BACKOFF_MAX: Duration = Duration::from_secs(10);
const MAX_CONSECUTIVE_RESTARTS: u32 = 5;

#[derive(Clone, Serialize)]
pub struct Endpoint {
    pub url: String,
    pub token: String,
    #[serde(rename = "environmentId")]
    pub environment_id: String,
}

#[derive(Clone, Serialize)]
struct Status {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    endpoint: Option<Endpoint>,
    stopping: bool,
}

pub struct Supervisor {
    inner: Arc<Mutex<Inner>>,
}

impl Supervisor {
    /// Spawns the supervision loop on a plain OS thread and returns immediately.
    pub fn start(app: AppHandle) -> Self {
        let inner = Arc::new(Mutex::new(Inner::default()));
        let worker = Arc::clone(&inner);
        std::thread::Builder::new()
            .name("tide-server-supervisor".into())
            .spawn(move || supervise(app, worker))
            .expect("spawn supervisor thread");
        Self { inner }
    }

    pub fn endpoint(&self) -> Option<Endpoint> {
        self.inner.lock().ok()?.endpoint.clone()
    }

    /// Idempotent: stops the restart loop and kills the child.
    pub fn shutdown(&self) {
        let Ok(mut inner) = self.inner.lock() else { return };
        inner.stopping = true;
        if let Some(child) = inner.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        inner.child = None;
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/* ------------------------------------------------------------------ resolution */

/// How to launch the server: the bundled sidecar, or `node` on the repo sources in dev.
enum Launcher {
    Binary(PathBuf),
    Node { node: PathBuf, entry: PathBuf },
}

impl Launcher {
    fn command(&self) -> Command {
        match self {
            Launcher::Binary(path) => Command::new(path),
            Launcher::Node { node, entry } => {
                let mut cmd = Command::new(node);
                cmd.arg("--experimental-strip-types")
                    .arg("--no-warnings=ExperimentalWarning")
                    .arg(entry);
                cmd
            }
        }
    }

    fn describe(&self) -> String {
        match self {
            Launcher::Binary(p) => p.display().to_string(),
            Launcher::Node { entry, .. } => format!("node {}", entry.display()),
        }
    }
}

/// `TIDE_SERVER_PATH` > bundled sidecar next to the executable > repo sources via node.
fn resolve_launcher() -> Result<Launcher, String> {
    if let Some(explicit) = std::env::var_os("TIDE_SERVER_PATH") {
        let path = PathBuf::from(explicit);
        if path.is_file() {
            return Ok(Launcher::Binary(path));
        }
        return Err(format!("TIDE_SERVER_PATH is not a file: {}", path.display()));
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            // Tauri strips the target-triple suffix when it stages an externalBin, but a
            // hand-built binaries/ dir still carries it — accept both.
            let triple_name = format!("tide-server-{}{}", target_triple(), std::env::consts::EXE_SUFFIX);
            for name in [format!("tide-server{}", std::env::consts::EXE_SUFFIX), triple_name] {
                let candidate = dir.join(&name);
                if candidate.is_file() {
                    return Ok(Launcher::Binary(candidate));
                }
            }
        }
    }

    let entry = find_repo_entry().ok_or_else(|| {
        "no tide-server sidecar next to the executable and no apps/server/src/bin.ts above it".to_string()
    })?;
    Ok(Launcher::Node {
        node: which_node().ok_or_else(|| "`node` is not on PATH".to_string())?,
        entry,
    })
}

fn target_triple() -> &'static str {
    // Kept in sync with scripts/build-server-sidecar.sh.
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "aarch64-apple-darwin"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "x86_64-apple-darwin"
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        "aarch64-unknown-linux-gnu"
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        "x86_64-unknown-linux-gnu"
    } else {
        "x86_64-pc-windows-msvc"
    }
}

/// Walks up from the executable and the cwd looking for the server entrypoint.
fn find_repo_entry() -> Option<PathBuf> {
    const REL: &str = "apps/server/src/bin.ts";
    let starts = [std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)), std::env::current_dir().ok()];
    for start in starts.into_iter().flatten() {
        if let Some(found) = start.ancestors().map(|dir| dir.join(REL)).find(|c| c.is_file()) {
            return Some(found);
        }
    }
    None
}

fn which_node() -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    // A GUI launch inherits a bare PATH, so also look where nvm/homebrew put node.
    let extra = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from);
    std::env::split_paths(&path)
        .chain(extra)
        .map(|dir| dir.join(format!("node{}", std::env::consts::EXE_SUFFIX)))
        .find(|c| c.is_file())
}

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

fn tide_home() -> Result<PathBuf, String> {
    let home = match std::env::var_os("TIDE_HOME") {
        Some(v) => PathBuf::from(v),
        None => dirs_home().ok_or("cannot determine the home directory")?.join(".tide"),
    };
    std::fs::create_dir_all(&home).map_err(|e| format!("cannot create {}: {e}", home.display()))?;
    Ok(home)
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from)
}

/* ------------------------------------------------------------------ health + identity */

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

/* ------------------------------------------------------------------ supervision loop */

fn supervise(app: AppHandle, inner: Arc<Mutex<Inner>>) {
    let mut failures: u32 = 0;
    let mut backoff = BACKOFF_MIN;

    loop {
        if inner.lock().map(|i| i.stopping).unwrap_or(true) {
            return;
        }
        let first = failures == 0;
        status(&app, if first { "starting" } else { "restarting" }, None);

        match boot(&app, &inner) {
            Ok(started_at) => {
                failures = 0;
                backoff = BACKOFF_MIN;
                let code = wait_for_exit(&inner);
                if inner.lock().map(|i| i.stopping).unwrap_or(true) {
                    return;
                }
                // A server that stayed up counts as healthy: reset the failure budget.
                if started_at.elapsed() < Duration::from_secs(20) {
                    failures = 1;
                }
                status(&app, "restarting", Some(format!("server exited ({code}); restarting")));
            }
            Err(err) => {
                failures += 1;
                if failures >= MAX_CONSECUTIVE_RESTARTS {
                    status(&app, "failed", Some(format!("{err}\n\ngave up after {failures} attempts")));
                    return;
                }
                status(&app, "restarting", Some(format!("{err}; retrying in {}s", backoff.as_secs_f32())));
                std::thread::sleep(backoff);
                backoff = (backoff * 2).min(BACKOFF_MAX);
            }
        }
    }
}

/// Spawns one server generation and blocks until it is healthy and the webview points at it.
fn boot(app: &AppHandle, inner: &Arc<Mutex<Inner>>) -> Result<Instant, String> {
    let launcher = resolve_launcher()?;
    let home = tide_home()?;
    let port = free_port()?;

    let mut cmd = launcher.command();
    cmd.arg("--port")
        .arg(port.to_string())
        .arg("--host")
        .arg("127.0.0.1")
        .env("TIDE_HOME", &home)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if tauri::is_dev() {
        // Dev also accepts `?token=` on the websocket, which is what we hand the web app.
        cmd.arg("--dev");
    }
    if let Launcher::Node { entry, .. } = &launcher {
        if let Some(repo) = entry.ancestors().nth(4) {
            cmd.current_dir(repo);
        }
    }

    let child = cmd.spawn().map_err(|e| format!("cannot start {}: {e}", launcher.describe()))?;
    let started_at = Instant::now();
    register_child(inner, child);

    let deadline = Instant::now() + HEALTH_TIMEOUT;
    while Instant::now() < deadline {
        if health_ok(port) {
            let (token, environment_id) = read_identity(&home)?;
            let endpoint = Endpoint {
                url: format!("ws://127.0.0.1:{port}/ws"),
                token,
                environment_id,
            };
            if let Ok(mut guard) = inner.lock() {
                guard.endpoint = Some(endpoint.clone());
            }
            status(app, "ready", Some(format!("connected to {}", endpoint.url)));
            open_web_app(app, &endpoint);
            // The app is usable now — look for a newer release without blocking it.
            crate::updater::check_on_launch(app.clone());
            return Ok(started_at);
        }
        if exited(inner) {
            return Err(format!("{} exited before becoming healthy", launcher.describe()));
        }
        std::thread::sleep(HEALTH_INTERVAL);
    }
    kill_child(inner);
    Err(format!("{} did not answer /health within {}s", launcher.describe(), HEALTH_TIMEOUT.as_secs()))
}

fn register_child(inner: &Arc<Mutex<Inner>>, child: Child) {
    if let Ok(mut guard) = inner.lock() {
        if let Some(old) = guard.child.as_mut() {
            let _ = old.kill();
            let _ = old.wait();
        }
        #[cfg(unix)]
        arm_signal_guard(child.id());
        guard.child = Some(child);
    }
}

fn kill_child(inner: &Arc<Mutex<Inner>>) {
    if let Ok(mut guard) = inner.lock() {
        if let Some(child) = guard.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
        }
        guard.child = None;
    }
}

fn exited(inner: &Arc<Mutex<Inner>>) -> bool {
    let Ok(mut guard) = inner.lock() else { return true };
    match guard.child.as_mut() {
        Some(child) => matches!(child.try_wait(), Ok(Some(_)) | Err(_)),
        None => true,
    }
}

/// Polls the child rather than holding the mutex across `wait()`, so `shutdown()` can win.
fn wait_for_exit(inner: &Arc<Mutex<Inner>>) -> String {
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

/* ------------------------------------------------------------------ webview handoff */

fn status(app: &AppHandle, state: &'static str, message: Option<String>) {
    let payload = Status { state, message: message.clone() };
    let _ = app.emit(STATUS_EVENT, &payload);
    // The splash page has no ACL of its own, so push the text into it directly.
    if let Some(win) = app.get_webview_window("main") {
        let text = serde_json::to_string(&message.unwrap_or_else(|| state.to_string())).unwrap_or_else(|_| "\"\"".into());
        let _ = win.eval(format!("window.__tideStatus && window.__tideStatus(\"{state}\", {text})"));
    }
}

/// The web app never imports Tauri: it learns the endpoint from its own query string.
fn open_web_app(app: &AppHandle, endpoint: &Endpoint) {
    let base = if tauri::is_dev() { "http://localhost:5173" } else { "tauri://localhost" };
    let target = format!(
        "{base}/?token={}&server={}",
        urlencode(&endpoint.token),
        urlencode(&endpoint.url)
    );
    let Some(win) = app.get_webview_window("main") else { return };
    match target.parse() {
        Ok(url) => {
            let _ = win.navigate(url);
        }
        Err(e) => status(app, "failed", Some(format!("bad web app url {target}: {e}"))),
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

/* ------------------------------------------------------------------ signals */

#[cfg(unix)]
mod signals {
    use std::sync::atomic::{AtomicU32, Ordering};

    pub static CHILD_PID: AtomicU32 = AtomicU32::new(0);

    /// Async-signal-safe: kill the recorded child, then leave.
    pub extern "C" fn on_term(sig: i32) {
        let pid = CHILD_PID.load(Ordering::SeqCst);
        if pid != 0 {
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        }
        unsafe { libc::_exit(128 + sig) };
    }
}

#[cfg(unix)]
fn arm_signal_guard(pid: u32) {
    use std::sync::atomic::Ordering;
    use std::sync::Once;
    signals::CHILD_PID.store(pid, Ordering::SeqCst);
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        libc::signal(libc::SIGTERM, signals::on_term as *const () as libc::sighandler_t);
    });
}
