//! Child-process plumbing: own process group, graceful stop, rotating log file.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const LOG_MAX: u64 = 5 * 1024 * 1024;
const LOG_KEEP: u32 = 2;
const STOP_GRACE: Duration = Duration::from_secs(5);

/// `TIDE_HOME/logs/server.log`, rotated to `.1` / `.2` once it passes 5 MB.
pub struct LogSink {
    path: PathBuf,
    file: File,
    size: u64,
}

pub type SharedSink = Arc<Mutex<LogSink>>;

impl LogSink {
    pub fn open(home: &Path) -> std::io::Result<SharedSink> {
        let dir = home.join("logs");
        fs::create_dir_all(&dir)?;
        let path = dir.join("server.log");
        let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        let file = OpenOptions::new().create(true).append(true).open(&path)?;
        Ok(Arc::new(Mutex::new(Self { path, file, size })))
    }

    fn numbered(&self, n: u32) -> PathBuf {
        let mut name = self.path.clone().into_os_string();
        name.push(format!(".{n}"));
        PathBuf::from(name)
    }

    fn write(&mut self, bytes: &[u8]) {
        if self.size + bytes.len() as u64 > LOG_MAX {
            self.rotate();
        }
        if self.file.write_all(bytes).is_ok() {
            self.size += bytes.len() as u64;
        }
    }

    fn rotate(&mut self) {
        for n in (1..=LOG_KEEP).rev() {
            let from = if n == 1 { self.path.clone() } else { self.numbered(n - 1) };
            let to = self.numbered(n);
            let _ = fs::remove_file(&to);
            let _ = fs::rename(from, to);
        }
        if let Ok(file) = OpenOptions::new().create(true).write(true).truncate(true).open(&self.path) {
            self.file = file;
            self.size = 0;
        }
    }
}

fn pump(mut reader: impl Read + Send + 'static, sink: SharedSink, echo: bool) {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            if echo {
                let _ = std::io::stderr().write_all(&buf[..n]);
            }
            if let Ok(mut s) = sink.lock() {
                s.write(&buf[..n]);
            }
        }
    });
}

/// Spawns the server in its own process group with output going to the log (and the
/// console when `echo`).
pub fn spawn(cmd: &mut Command, sink: &SharedSink, echo: bool) -> std::io::Result<Child> {
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = cmd.spawn()?;
    if let Some(out) = child.stdout.take() {
        pump(out, Arc::clone(sink), echo);
    }
    if let Some(err) = child.stderr.take() {
        pump(err, Arc::clone(sink), echo);
    }
    #[cfg(unix)]
    signals::arm(child.id());
    Ok(child)
}

/// SIGTERM the group, wait up to 5 s, then SIGKILL it. Windows has no graceful signal for a
/// console-less child, so `taskkill /T /F` ends the whole tree immediately (known gap).
pub fn stop(child: &mut Child) {
    #[cfg(unix)]
    {
        signals::disarm();
        unsafe { libc::killpg(child.id() as libc::pid_t, libc::SIGTERM) };
    }
    #[cfg(windows)]
    kill_tree(child.id());
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline {
        if !matches!(child.try_wait(), Ok(None)) {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    #[cfg(unix)]
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL)
    };
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn kill_tree(pid: u32) {
    use std::os::windows::process::CommandExt;
    let _ = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .creation_flags(0x0800_0000)
        .status();
}

#[cfg(unix)]
mod signals {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Once;

    static CHILD_PID: AtomicU32 = AtomicU32::new(0);

    /// Async-signal-safe: TERM the child's group, give it 5 s, KILL it, leave.
    extern "C" fn on_signal(sig: i32) {
        let pid = CHILD_PID.load(Ordering::SeqCst) as libc::pid_t;
        if pid != 0 {
            unsafe {
                libc::killpg(pid, libc::SIGTERM);
                for _ in 0..50 {
                    let mut status = 0;
                    if libc::waitpid(pid, &mut status, libc::WNOHANG) != 0 {
                        break;
                    }
                    libc::usleep(100_000);
                }
                libc::killpg(pid, libc::SIGKILL);
            }
        }
        unsafe { libc::_exit(128 + sig) };
    }

    pub fn arm(pid: u32) {
        CHILD_PID.store(pid, Ordering::SeqCst);
        static ONCE: Once = Once::new();
        ONCE.call_once(|| unsafe {
            for sig in [libc::SIGTERM, libc::SIGINT] {
                libc::signal(sig, on_signal as *const () as libc::sighandler_t);
            }
        });
    }

    pub fn disarm() {
        CHILD_PID.store(0, Ordering::SeqCst);
    }
}
