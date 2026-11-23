// Evidence helpers for scripts/desktop-ui-smoke.mjs that need no CDP: Windows process lists,
// listening ports, desktop screenshots with window/client rects and pixel analysis, the webview's
// connection to tide-server, the process-tree kill, and the Chromium log file that WebView2 (or
// Chrome) writes when given --enable-logging. Every helper resolves with data and never throws;
// the Windows ones return { skipped } elsewhere. evidenceLines() renders all of it for summary.txt.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pixelEvidence, pixelLine } from "./desktop-ui-smoke-png.mjs";

export const IS_WIN = process.platform === "win32";
const WEBVIEW_LOG_TAIL = 200;
const WEBVIEW_LOG_HIGHLIGHTS = 40;
const DEBUG_FLAG = "--remote-debugging-port=";

/** Runs a command; resolves { ok, out, error } (stdout kept on failure too). */
export function runCmd(cmd, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 16 << 20 }, (err, stdout, stderr) => {
      const out = String(stdout ?? "").trim();
      resolve(err ? { ok: false, out, error: String(stderr || err.message).trim() } : { ok: true, out });
    });
  });
}

/** -EncodedCommand (UTF-16LE base64) sidesteps Windows argv re-quoting of embedded quotes. */
export function runPowerShell(script, timeoutMs = 30_000) {
  const full = `$ProgressPreference = 'SilentlyContinue'; $ErrorActionPreference = 'Stop'; ${script}`;
  const encoded = Buffer.from(full, "utf16le").toString("base64");
  return runCmd("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], timeoutMs);
}

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function psJson(script, timeoutMs) {
  const r = await runPowerShell(script, timeoutMs);
  if (!r.ok) return { error: r.error || "powershell failed", out: r.out.slice(0, 2000) };
  try {
    return JSON.parse(r.out);
  } catch (e) {
    return { error: `unparseable powershell output: ${e.message}`, out: r.out.slice(0, 2000) };
  }
}

/**
 * Every process whose image name matches one of `patterns` (PowerShell -like wildcards): pid,
 * parent pid, command line, plus the TCP ports those pids listen on.
 */
export async function winProcesses(patterns) {
  if (!IS_WIN) return { skipped: "not windows" };
  const likes = patterns.map((p) => `$_.Name -like ${psQuote(p)}`).join(" -or ");
  const script = `
$procs = @(Get-CimInstance Win32_Process | Where-Object { ${likes} } |
  ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; commandLine = $_.CommandLine } })
$ids = @($procs | ForEach-Object { $_.pid })
$listen = @(); $listenSource = 'Get-NetTCPConnection'
try {
  $listen = @(Get-NetTCPConnection -State Listen | Where-Object { $ids -contains [int]$_.OwningProcess } |
    ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; address = [string]$_.LocalAddress; port = [int]$_.LocalPort } })
} catch {
  $listenSource = 'netstat'
  $listen = @(netstat -ano -p TCP | Select-String 'LISTENING' | ForEach-Object {
    $f = -split $_.Line.Trim(); $i = $f[1].LastIndexOf(':')
    [pscustomobject]@{ pid = [int]$f[-1]; address = $f[1].Substring(0, $i); port = [int]$f[1].Substring($i + 1) } } |
    Where-Object { $ids -contains $_.pid })
}
[pscustomobject]@{ processes = $procs; listening = $listen; listenSource = $listenSource } | ConvertTo-Json -Depth 4 -Compress`;
  const res = await psJson(script, 45_000);
  if (res.error) return res;
  const webviews = (res.processes ?? []).filter((p) => /^msedgewebview2\.exe$/i.test(p.name ?? ""));
  res.webviewCount = webviews.length;
  res.debugFlagPids = webviews.filter((p) => (p.commandLine ?? "").includes(DEBUG_FLAG)).map((p) => p.pid);
  return res;
}

/**
 * Full-screen capture of the primary screen plus the app's top-level windows: outer rect (includes
 * the invisible resize borders), client rect in screen coordinates (below title and menu bar), and
 * the screen work area (excludes the taskbar).
 */
export async function winDesktop(file, exeBaseName) {
  if (!IS_WIN) return { skipped: "not windows" };
  const procName = exeBaseName.replace(/\.exe$/i, "");
  const script = `
$result = [ordered]@{ file = ${psQuote(file)}; screen = $null; workArea = $null; windows = @(); errors = @() }
try {
  Add-Type -AssemblyName System.Windows.Forms, System.Drawing
  $s = [System.Windows.Forms.Screen]::PrimaryScreen
  $b = $s.Bounds
  $w = $s.WorkingArea
  $result.workArea = [pscustomobject]@{ left = $w.Left; top = $w.Top; right = $w.Right; bottom = $w.Bottom }
  $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save(${psQuote(file)}, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
  $result.screen = "$($b.Width)x$($b.Height)"
} catch { $result.errors += "screenshot: $($_.Exception.Message)" }
try {
  Add-Type -Namespace TideSmoke -Name User32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public struct POINT { public int X; public int Y; }
'@
  $result.windows = @(Get-Process -Name ${psQuote(procName)} -ErrorAction SilentlyContinue | ForEach-Object {
    $h = $_.MainWindowHandle; $r = New-Object TideSmoke.User32+RECT
    $hasRect = ($h -ne [IntPtr]::Zero) -and [TideSmoke.User32]::GetWindowRect($h, [ref]$r)
    $outer = $null; $client = $null; $clientError = $null
    if ($hasRect) { $outer = [pscustomobject]@{ left = $r.Left; top = $r.Top; right = $r.Right; bottom = $r.Bottom } }
    if ($h -ne [IntPtr]::Zero) {
      try {
        $c = New-Object TideSmoke.User32+RECT
        $p = New-Object TideSmoke.User32+POINT
        if ([TideSmoke.User32]::GetClientRect($h, [ref]$c) -and [TideSmoke.User32]::ClientToScreen($h, [ref]$p)) {
          $client = [pscustomobject]@{ left = $p.X; top = $p.Y; right = $p.X + $c.Right; bottom = $p.Y + $c.Bottom }
        } else { $clientError = 'GetClientRect/ClientToScreen returned false' }
      } catch { $clientError = $_.Exception.Message }
    }
    [pscustomobject]@{ pid = $_.Id; title = $_.MainWindowTitle; handle = [int64]$h; responding = $_.Responding;
      visible = ($h -ne [IntPtr]::Zero) -and [TideSmoke.User32]::IsWindowVisible($h);
      minimized = ($h -ne [IntPtr]::Zero) -and [TideSmoke.User32]::IsIconic($h);
      rect = $(if ($hasRect) { "$($r.Left),$($r.Top) $($r.Right - $r.Left)x$($r.Bottom - $r.Top)" } else { $null });
      outer = $outer; client = $client; clientError = $clientError } })
} catch { $result.errors += "windows: $($_.Exception.Message)" }
[pscustomobject]$result | ConvertTo-Json -Depth 5 -Compress`;
  const res = await psJson(script, 45_000);
  res.screenshot = fs.existsSync(file) ? path.basename(file) : null;
  if (res.screenshot) res.pixels = pixelEvidence(file, res.windows, res.workArea);
  return res;
}

/**
 * Whether one of the app's msedgewebview2 processes holds an established TCP connection to the
 * tide-server port: the web app opens that WebSocket once its JavaScript boots, the splash does
 * not. Webviews = descendants of the app exe plus any carrying --webview-exe-name=<exe>; the app
 * exe's own health checks do not count. connected is null when the query could not be made.
 */
export async function winServerConnection(exeBaseName, serverPort) {
  if (!IS_WIN) return { connected: null, skipped: "not windows" };
  if (!serverPort) return { connected: null, error: "tide-server port unknown" };
  const script = `
$all = @(Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ id = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; cmd = [string]$_.CommandLine } })
$tree = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($p in $all) { if ($p.name -eq ${psQuote(exeBaseName)}) { [void]$tree.Add($p.id) } }
do {
  $added = 0
  foreach ($p in $all) { if ($p.id -ne 0 -and -not $tree.Contains($p.id) -and $tree.Contains($p.ppid)) { [void]$tree.Add($p.id); $added++ } }
} while ($added -gt 0)
$marker = ${psQuote(`--webview-exe-name=${exeBaseName}`)}
$webviews = @($all | Where-Object { $_.name -eq 'msedgewebview2.exe' -and ($tree.Contains($_.id) -or $_.cmd.Contains($marker)) } | ForEach-Object { $_.id })
$source = 'Get-NetTCPConnection'
try {
  $conns = @(Get-NetTCPConnection -State Established -RemotePort ${Number(serverPort)} -ErrorAction SilentlyContinue |
    ForEach-Object { [pscustomobject]@{ pid = [int]$_.OwningProcess; local = "$($_.LocalAddress):$($_.LocalPort)"; remote = "$($_.RemoteAddress):$($_.RemotePort)" } })
} catch {
  $source = 'netstat'
  $conns = @(netstat -ano -p TCP | Select-String 'ESTABLISHED' | ForEach-Object {
    $f = -split $_.Line.Trim()
    [pscustomobject]@{ pid = [int]$f[-1]; local = $f[1]; remote = $f[2] } } |
    Where-Object { $_.remote.EndsWith(':${Number(serverPort)}') })
}
$names = @{}; foreach ($p in $all) { $names[$p.id] = $p.name }
$conns = @($conns | ForEach-Object { $_ | Add-Member -NotePropertyName name -NotePropertyValue $names[$_.pid] -PassThru })
[pscustomobject]@{ webviewPids = $webviews; appTree = @($tree); connections = $conns; source = $source } | ConvertTo-Json -Depth 4 -Compress`;
  const res = await psJson(script, 45_000);
  if (res.error) return { connected: null, serverPort, ...res };
  const webviews = new Set(res.webviewPids ?? []);
  const matching = (res.connections ?? []).filter((c) => webviews.has(c.pid));
  return { connected: webviews.size === 0 ? false : matching.length > 0, serverPort, matching, ...res };
}

/** One-line rendering of the connection check for summary.txt. */
export function connectionLine(c) {
  if (!c) return "connection: n/a (not queried)";
  if (c.connected === null) return `connection: unknown (${c.error ?? c.skipped ?? "query failed"})`;
  const show = (list) => JSON.stringify((list ?? []).map((m) => `${m.name ?? "?"} ${m.pid} ${m.local} -> ${m.remote}`));
  const head = `connection: ${c.connected} — webview -> tide-server :${c.serverPort} ${show(c.matching)}`;
  return `${head}; all established to that port ${show(c.connections)} (${c.webviewPids?.length ?? 0} webview pids, via ${c.source})`;
}

/** tide-server port from a captured `tide-server.exe --port N` command line (when its log is silent). */
export function serverPortFromProcesses(round) {
  for (const e of [...(round.win?.processes ?? [])].reverse()) {
    for (const p of e.processes ?? []) {
      const m = /^tide-server/i.test(p.name ?? "") && /--port[= ](\d+)/.exec(p.commandLine ?? "");
      if (m) return Number(m[1]);
    }
  }
  return null;
}

/** Waits (killing stragglers) until no app exe and no webview using `userDataDir` is left. */
export async function winWaitGone(exeBaseName, userDataDir, timeoutSec = 20) {
  if (!IS_WIN) return { skipped: "not windows" };
  const script = `
$deadline = (Get-Date).AddSeconds(${Number(timeoutSec)}); $killed = @(); $left = @()
do {
  $left = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq ${psQuote(exeBaseName)} -or ($_.Name -eq 'msedgewebview2.exe' -and ([string]$_.CommandLine).Contains(${psQuote(userDataDir)})) })
  if ($left.Count -eq 0) { break }
  foreach ($p in $left) { $killed += [int]$p.ProcessId; Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
[pscustomobject]@{ gone = ($left.Count -eq 0); remaining = @($left | ForEach-Object { [int]$_.ProcessId }); killed = @($killed | Select-Object -Unique) } | ConvertTo-Json -Compress`;
  return psJson(script, (timeoutSec + 30) * 1000);
}

/** Windows: kill the app tree, any leftover sidecar, and WebView2 browsers launched with our port. */
export async function winKill(pid, exe, port) {
  const steps = [];
  if (pid) steps.push({ cmd: `taskkill /PID ${pid} /T /F`, ...(await runCmd("taskkill", ["/PID", String(pid), "/T", "/F"])) });
  if (exe) steps.push({ cmd: `taskkill /IM ${path.basename(exe)} /T /F`, ...(await runCmd("taskkill", ["/IM", path.basename(exe), "/T", "/F"])) });
  const ps =
    "Get-Process | Where-Object { $_.ProcessName -like 'tide-server*' } | Stop-Process -Force -ErrorAction SilentlyContinue; " +
    `Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" | Where-Object { $_.CommandLine -like '*${DEBUG_FLAG}${port}*' } | ` +
    "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
  steps.push({ cmd: `powershell: ${ps}`, ...(await runPowerShell(ps)) });
  return steps;
}

/**
 * Where Chromium should write its log for a round. --log-file cannot be quoted inside
 * WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, so a path with a space goes to the temp dir instead.
 */
export function webviewLogPlan(outDir, roundName) {
  const wanted = path.join(outDir, `${roundName}-webview2.log`);
  const target = /\s/.test(wanted) ? path.join(os.tmpdir(), `desktop-ui-smoke-${process.pid}-${roundName}-webview2.log`) : wanted;
  if (/\s/.test(target)) return { wanted, target: null, error: "no space-free path for --log-file" };
  fs.rmSync(target, { force: true });
  return { wanted, target };
}

/** After a round: copy the redacted tail next to the report and pull out console/error lines. */
export function collectWebviewLog(plan, redact) {
  if (!plan.target) return { found: false, note: plan.error };
  if (!fs.existsSync(plan.target)) {
    return { found: false, note: `Chromium log ${plan.target} never appeared (--enable-logging / the env var was not honoured)` };
  }
  const lines = fs.readFileSync(plan.target, "utf8").split(/\r?\n/).filter(Boolean);
  const tail = path.basename(plan.wanted).replace(/\.log$/, ".tail.txt");
  fs.writeFileSync(path.join(path.dirname(plan.wanted), tail), redact(lines.slice(-WEBVIEW_LOG_TAIL).join("\n")) + "\n");
  // only the redacted tail stays: the raw log holds the session token in page URLs
  let removed = true;
  try {
    fs.rmSync(plan.target, { force: true });
  } catch {
    removed = false; // a dying WebView2 can still hold the file on Windows
    if (plan.target === plan.wanted) fs.writeFileSync(plan.target, "(raw log replaced by the redacted tail)\n");
  }
  // page console lines first: they are what the CDP channel would have shown
  const consoleLines = lines.filter((l) => /CONSOLE[(:]/.test(l));
  const errorLines = lines.filter((l) => !/CONSOLE[(:]/.test(l) && /:ERROR:|:FATAL:/.test(l));
  const highlights = [...consoleLines, ...errorLines].slice(0, WEBVIEW_LOG_HIGHLIGHTS);
  return { found: true, lines: lines.length, consoleLines: consoleLines.length, tail, highlights, rawRemoved: removed };
}

/** Windows evidence that needs no CDP, as recorded in round.win; resolves to null elsewhere. Never throws. */
export async function windowsEvidence(round, kind, label, exe) {
  if (!IS_WIN) return null;
  round.win ??= { processes: [], desktop: [] };
  const t = round.t();
  const entry =
    kind === "processes"
      ? await winProcesses(["tide-desktop*", "tide-server*", "msedgewebview2.exe", path.basename(exe)])
      : await winDesktop(path.join(round.outDir, `${round.name}-desktop-${label}.png`), path.basename(exe));
  const record = { label, t, ...entry };
  round.win[kind].push(record);
  return record;
}

/** Port polling, Chromium log and Windows process/desktop evidence for one round. */
export function evidenceLines(r) {
  const lines = [];
  const p = r.poll;
  if (p) {
    lines.push(
      `debug port: ${p.attempts} polls, /json/version answered ${p.versionAnswers}x, /json/list ${p.listAnswers}x` +
        ` (by ${JSON.stringify(p.answeredBy)}; first answer ${p.firstAnswerMs ?? "never"} ms)`,
    );
    if (p.lastError) lines.push(`   last poll error: ${p.lastError}`);
    if (Array.isArray(p.lastList)) lines.push(`   last /json/list: ${JSON.stringify(p.lastList.map((t) => `${t.type} ${t.url}`))}`);
    if (p.choice) lines.push(`   attached to: ${p.choice.type} ${p.choice.url}${p.choice.fallback ? " (fallback)" : ""}`);
  }
  if (r.timings?.serverListeningMs != null) lines.push(`tide-server listening (per its log) at ${r.timings.serverListeningMs} ms`);
  const wl = r.webviewLog;
  if (wl?.found) {
    lines.push(`chromium log: ${wl.lines} lines, ${wl.consoleLines} CONSOLE (tail in ${wl.tail}); first console/error lines:`);
    lines.push(...wl.highlights.map((l) => `   ${l.slice(0, 400)}`));
  }
  for (const e of r.win?.processes ?? []) {
    if (e.error) {
      lines.push(`windows processes @${e.label}: ERROR ${e.error}`);
      continue;
    }
    const procs = e.processes ?? [];
    const flag = e.debugFlagPids?.length ? `YES (pids ${e.debugFlagPids.join(", ")})` : "NO";
    lines.push(
      `windows processes @${e.label} (${e.t} ms): ${procs.length} processes, ${e.webviewCount} msedgewebview2;` +
        ` a msedgewebview2 command line contains --remote-debugging-port=: ${flag}`,
      `   listening: ${JSON.stringify((e.listening ?? []).map((l) => `${l.pid} ${l.address}:${l.port}`))} (via ${e.listenSource})`,
    );
  }
  for (const d of r.win?.desktop ?? []) {
    const wins = (d.windows ?? []).map((w) => {
      const c = w.client ? `${w.client.left},${w.client.top} ${w.client.right - w.client.left}x${w.client.bottom - w.client.top}` : `n/a${w.clientError ? ` (${w.clientError})` : ""}`;
      return `"${w.title}" visible=${w.visible} minimized=${w.minimized} rect=${w.rect} client=${c}`;
    });
    lines.push(`desktop @${d.label} (${d.t} ms): ${d.screenshot ?? "no screenshot"} ${d.screen ?? ""} windows=${JSON.stringify(wins)}`);
    if (d.screenshot) lines.push(`   ${pixelLine(d.pixels)}`);
    for (const err of [d.error, ...(d.errors ?? [])].filter(Boolean)) lines.push(`   desktop error: ${err}`);
  }
  return lines;
}
