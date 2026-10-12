//! Locating the server: which binary to run, where `TIDE_HOME` is, which port to use.

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;

/// How to launch the server: the bundled sidecar, or `node` on the repo sources in dev.
pub enum Launcher {
    Binary(PathBuf),
    Node { node: PathBuf, entry: PathBuf },
}

impl Launcher {
    pub fn command(&self) -> Command {
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

    pub fn describe(&self) -> String {
        match self {
            Launcher::Binary(p) => p.display().to_string(),
            Launcher::Node { entry, .. } => format!("node {}", entry.display()),
        }
    }
}

/// `TIDE_SERVER_PATH` > bundled sidecar next to the executable > repo sources via node.
pub fn resolve_launcher() -> Result<Launcher, String> {
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

pub fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    listener.local_addr().map(|a| a.port()).map_err(|e| e.to_string())
}

pub fn tide_home() -> Result<PathBuf, String> {
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
