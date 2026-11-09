//! `<TIDE_HOME>/shell.json`: which server the window shows. `local` spawns the sidecar,
//! `attach` reuses the server already holding `TIDE_HOME`, `remote` opens another machine
//! paired from the splash. Also the desktop-only server settings the shell reads at boot.

use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Local,
    Attach,
    Remote,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Remote {
    /// `http(s)://host:port` of the other machine's server
    pub url: String,
    /// its per-device token from `POST /api/auth/pair`
    pub token: String,
    #[serde(rename = "clientId", default, skip_serializing_if = "Option::is_none")]
    pub client_id: Option<String>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellConfig {
    #[serde(default)]
    pub mode: Mode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote: Option<Remote>,
}

/// A missing or unreadable file is the default (local); the shell must always start.
pub fn load(home: &Path) -> ShellConfig {
    std::fs::read_to_string(home.join("shell.json")).ok().map(|raw| parse(&raw)).unwrap_or_default()
}

fn parse(raw: &str) -> ShellConfig {
    let cfg: ShellConfig = serde_json::from_str(raw).unwrap_or_default();
    // remote without a stored machine cannot open anything
    if cfg.mode == Mode::Remote && cfg.remote.is_none() {
        return ShellConfig { mode: Mode::Local, remote: None };
    }
    cfg
}

/// Written 0600 on unix: it may hold a device token.
pub fn save(home: &Path, cfg: &ShellConfig) -> Result<(), String> {
    let path = home.join("shell.json");
    let body = serde_json::to_vec_pretty(cfg).map_err(|e| e.to_string())?;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
    let mut file = opts.open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
    std::io::Write::write_all(&mut file, &body).map_err(|e| format!("{}: {e}", path.display()))
}

/// Keeps the stored remote machine, so switching back to it later needs no new code.
pub fn set_mode(home: &Path, mode: Mode) -> Result<(), String> {
    let mut cfg = load(home);
    if mode == Mode::Remote && cfg.remote.is_none() {
        return Err("no remote machine has been paired".into());
    }
    cfg.mode = mode;
    save(home, &cfg)
}

/// `http://host:port[/…]` -> `ws://host:port/ws`; `https:` -> `wss:`.
pub fn ws_url_for(http_url: &str) -> Result<String, String> {
    let trimmed = http_url.trim();
    let (scheme, rest) = match trimmed.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => ("http".to_string(), trimmed),
    };
    let ws = match scheme.as_str() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        other => return Err(format!("unsupported scheme {other}:")),
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or_default();
    if host.is_empty() {
        return Err(format!("no host in {http_url}"));
    }
    Ok(format!("{ws}://{host}/ws"))
}

/// `environment.lanBind` from the server's own `settings.json`; absent or unreadable is false.
pub fn lan_bind(home: &Path) -> bool {
    std::fs::read_to_string(home.join("settings.json")).ok().is_some_and(|raw| parse_lan_bind(&raw))
}

fn parse_lan_bind(raw: &str) -> bool {
    #[derive(Deserialize, Default)]
    struct Env {
        #[serde(rename = "lanBind", default)]
        lan_bind: bool,
    }
    #[derive(Deserialize)]
    struct Settings {
        #[serde(default)]
        environment: Option<Env>,
    }
    serde_json::from_str::<Settings>(raw).ok().and_then(|s| s.environment).is_some_and(|e| e.lan_bind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modes_and_falls_back_to_local() {
        assert_eq!(parse(r#"{"mode":"attach"}"#).mode, Mode::Attach);
        assert_eq!(parse("not json"), ShellConfig::default());
        assert_eq!(parse("{}").mode, Mode::Local);
        assert_eq!(parse(r#"{"mode":"remote"}"#).mode, Mode::Local);
        let cfg = parse(r#"{"mode":"remote","remote":{"url":"http://10.0.0.5:3777","token":"t","clientId":"c1"}}"#);
        assert_eq!(cfg.mode, Mode::Remote);
        assert_eq!(cfg.remote.unwrap().client_id.as_deref(), Some("c1"));
    }

    #[test]
    fn round_trips_through_json() {
        let cfg = ShellConfig { mode: Mode::Remote, remote: Some(Remote { url: "https://a.ts.net".into(), token: "t".into(), client_id: None }) };
        let raw = serde_json::to_string(&cfg).unwrap();
        assert!(raw.contains(r#""mode":"remote""#) && !raw.contains("clientId"));
        assert_eq!(parse(&raw), cfg);
    }

    #[test]
    fn derives_the_socket_url() {
        assert_eq!(ws_url_for("http://192.168.1.20:3777").unwrap(), "ws://192.168.1.20:3777/ws");
        assert_eq!(ws_url_for("https://tide.example.ts.net/pair?x=1").unwrap(), "wss://tide.example.ts.net/ws");
        assert_eq!(ws_url_for("HTTP://host:1/").unwrap(), "ws://host:1/ws");
        assert_eq!(ws_url_for("10.0.0.5:3777").unwrap(), "ws://10.0.0.5:3777/ws");
        assert!(ws_url_for("ftp://x").is_err());
        assert!(ws_url_for("http://").is_err());
    }

    #[test]
    fn reads_lan_bind_tolerantly() {
        assert!(parse_lan_bind(r#"{"environment":{"name":"m","lanBind":true}}"#));
        assert!(!parse_lan_bind(r#"{"environment":{"name":"m"}}"#));
        assert!(!parse_lan_bind(r#"{"providers":{}}"#));
        assert!(!parse_lan_bind("{"));
    }
}
