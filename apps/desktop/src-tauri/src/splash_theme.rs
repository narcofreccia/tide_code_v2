//! The theme the splash paints in. The web app keeps the user's choice in its own storage, on
//! another origin, so the shell carries it over when it swaps the app for the splash
//! (`?theme=` on the splash URL) and keeps the last one in `<TIDE_HOME>/shell-theme` for the
//! next start. `system` (or nothing known yet) follows the OS.

use std::path::Path;

const FILE: &str = "shell-theme";

/// Navigates from the web app to the splash, reading the app's painted theme on the way
/// (`data-theme` on `<html>`, absent for `system`). `extra` is appended to the query.
pub fn handover_script(splash_url: &str, extra: &str) -> String {
    let target = serde_json::to_string(splash_url).unwrap_or_else(|_| "\"\"".into());
    let extra = serde_json::to_string(extra).unwrap_or_else(|_| "\"\"".into());
    format!("location.replace({target} + '?theme=' + encodeURIComponent(document.documentElement.dataset.theme || 'system') + {extra})")
}

/// The native window takes the saved theme too, so its first frame (before the page paints)
/// and the title bar match. `system` leaves it to the OS.
pub fn apply_to_window<R: tauri::Runtime>(win: &tauri::WebviewWindow<R>, home: Option<&Path>) {
    let theme = match resolve(home, None) {
        "dark" => Some(tauri::Theme::Dark),
        "light" => Some(tauri::Theme::Light),
        _ => None,
    };
    let _ = win.set_theme(theme);
}

/// `dark`, `light` or `system`; anything else is ignored.
fn parse(raw: &str) -> Option<&'static str> {
    match raw.trim() {
        "dark" => Some("dark"),
        "light" => Some("light"),
        "system" => Some("system"),
        _ => None,
    }
}

/// The theme for this splash: the one handed over in the query (saved for the next start),
/// else the saved one. Returns the value for `data-theme` (empty = follow the OS).
pub fn resolve(home: Option<&Path>, query: Option<&str>) -> &'static str {
    let handed = query.and_then(|q| q.split('&').find_map(|pair| pair.strip_prefix("theme=")).and_then(parse));
    let theme = match (handed, home) {
        (Some(t), Some(home)) => {
            let _ = std::fs::write(home.join(FILE), t);
            Some(t)
        }
        (Some(t), None) => Some(t),
        (None, Some(home)) => std::fs::read_to_string(home.join(FILE)).ok().as_deref().and_then(parse),
        (None, None) => None,
    };
    match theme {
        Some("dark") => "dark",
        Some("light") => "light",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-splash-theme-{}-{:?}", std::process::id(), std::thread::current().id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn handed_theme_wins_and_is_kept_for_the_next_start() {
        let home = scratch();
        assert_eq!(resolve(Some(&home), Some("theme=dark&connect=1")), "dark");
        assert_eq!(resolve(Some(&home), None), "dark");
        assert_eq!(resolve(Some(&home), Some("connect=1")), "dark");
        assert_eq!(resolve(Some(&home), Some("theme=system")), "");
        assert_eq!(resolve(Some(&home), None), "");
        assert_eq!(resolve(Some(&home), Some("theme=light")), "light");
    }

    #[test]
    fn unknown_values_and_no_history_follow_the_os() {
        let home = scratch();
        assert_eq!(resolve(Some(&home), None), "");
        assert_eq!(resolve(Some(&home), Some("theme=<script>")), "");
        assert_eq!(resolve(None, None), "");
    }

    #[test]
    fn handover_script_quotes_its_inputs() {
        let js = handover_script("tide-shell://localhost/", "&connect=1");
        assert_eq!(js, "location.replace(\"tide-shell://localhost/\" + '?theme=' + encodeURIComponent(document.documentElement.dataset.theme || 'system') + \"&connect=1\")");
    }
}
