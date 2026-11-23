//! Keeps the WebView2 profile free of service workers. On Windows the app origin
//! (`http://tauri.localhost`) is a secure context, and a worker left there by an older web
//! build turns every later launch into a black window before the page's own cleanup can run.

/// Removes `<root>/EBWebView/Default/Service Worker` (registrations, script cache, Cache
/// Storage). Returns whether there was anything to remove. Must run before WebView2 starts.
#[cfg(any(windows, test))]
pub fn purge_service_workers(root: &std::path::Path) -> std::io::Result<bool> {
    let dir = root.join("EBWebView").join("Default").join("Service Worker");
    match std::fs::remove_dir_all(&dir) {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err),
    }
}

#[cfg(test)]
mod tests {
    use super::purge_service_workers;
    use std::fs;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tide-webview-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn removes_service_workers_and_keeps_siblings() {
        let root = scratch("purge");
        let default = root.join("EBWebView").join("Default");
        fs::create_dir_all(default.join("Service Worker").join("CacheStorage")).unwrap();
        fs::write(default.join("Service Worker").join("Database"), b"x").unwrap();
        fs::create_dir_all(default.join("Local Storage")).unwrap();
        fs::write(default.join("Local Storage").join("x"), b"keep").unwrap();

        assert!(purge_service_workers(&root).unwrap());
        assert!(!default.join("Service Worker").exists());
        assert_eq!(fs::read(default.join("Local Storage").join("x")).unwrap(), b"keep");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn absent_directory_is_not_an_error() {
        let root = scratch("absent");
        assert!(!purge_service_workers(&root).unwrap());
    }
}
