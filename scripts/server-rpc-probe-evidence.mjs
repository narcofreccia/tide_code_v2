// Evidence for scripts/server-rpc-probe.mjs: the processes around tide-server (Windows: one
// Get-CimInstance Win32_Process query, as in desktop-ui-smoke-win.mjs; elsewhere `ps`), the
// on-disk state of a folder `project.init` is creating, and git facts taken by this script itself
// (`where git`, `git --version`, `git config --list`, and the server's own two git command lines
// run directly). Every helper resolves with data and never throws.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { IS_WIN, runCmd, runPowerShell } from "./desktop-ui-smoke-win.mjs";

/** Image names sampled on Windows (PowerShell -like patterns), plus every descendant of a tide-server. */
export const WIN_PATTERNS = ["git.exe", "git-*.exe", "sh.exe", "bash.exe", "gpg*.exe", "conhost.exe", "tide-server*.exe"];
const POSIX_NAME = /^(git|git-.*|sh|bash|zsh|gpg.*|tide-server.*)$/;

/** The server's argv for one git command (apps/server/src/vcs/git.ts `gitArgv`). */
export function gitArgv(args, platform = process.platform) {
  return platform === "win32" ? ["-c", "core.longpaths=true", "--no-pager", ...args] : ["--no-pager", ...args];
}
/** apps/server/src/rpc/handlers.ts INIT_IDENTITY and the two commands of `initProject`. */
export const INIT_IDENTITY = ["-c", "user.name=Tide", "-c", "user.email=tide@localhost"];
export const INIT_COMMANDS = [["init", "-q", "-b", "main"], [...INIT_IDENTITY, "commit", "-q", "--allow-empty", "-m", "Initial commit"]];

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function winSample(extraRootPids) {
  const roots = extraRootPids.filter((p) => Number.isInteger(p) && p > 0).join(",");
  const likes = WIN_PATTERNS.map((p) => `$_.name -like ${psQuote(p)}`).join(" -or ");
  const script = `
$all = @(Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = [string]$_.Name; commandLine = [string]$_.CommandLine;
    started = $(if ($_.CreationDate) { $_.CreationDate.ToString('o') } else { $null }) } })
$tree = New-Object 'System.Collections.Generic.HashSet[int]'
foreach ($p in $all) { if ($p.name -like 'tide-server*') { [void]$tree.Add($p.pid) } }
foreach ($r in @(${roots || "-1"})) { if ($r -gt 0) { [void]$tree.Add([int]$r) } }
do {
  $added = 0
  foreach ($p in $all) { if ($p.pid -ne 0 -and -not $tree.Contains($p.pid) -and $tree.Contains($p.ppid)) { [void]$tree.Add($p.pid); $added++ } }
} while ($added -gt 0)
$picked = @($all | Where-Object { $tree.Contains($_.pid) -or (${likes}) } |
  ForEach-Object { $_ | Add-Member -NotePropertyName inServerTree -NotePropertyValue ($tree.Contains($_.pid)) -PassThru })
[pscustomobject]@{ processes = $picked; total = $all.Count } | ConvertTo-Json -Depth 4 -Compress`;
  const r = await runPowerShell(script, 40_000);
  if (!r.ok) return { error: r.error || "powershell failed", out: r.out.slice(0, 1000) };
  try {
    const parsed = JSON.parse(r.out);
    return { processes: parsed.processes ?? [], total: parsed.total, source: "Get-CimInstance Win32_Process" };
  } catch (e) {
    return { error: `unparseable powershell output: ${e.message}`, out: r.out.slice(0, 1000) };
  }
}

async function posixSample(rootPids) {
  const r = await runCmd("ps", ["-A", "-o", "pid=,ppid=,lstart=,command="], 15_000);
  if (!r.ok) return { error: r.error };
  const all = r.out.split("\n").map((line) => {
    const f = line.trim().split(/\s+/);
    const command = f.slice(7).join(" ");
    const started = new Date(f.slice(2, 7).join(" "));
    return { pid: Number(f[0]), ppid: Number(f[1]), started: Number.isNaN(started.getTime()) ? f.slice(2, 7).join(" ") : started.toISOString(), name: path.basename(f[7] ?? ""), commandLine: command };
  }).filter((p) => Number.isInteger(p.pid));
  const tree = new Set(rootPids.filter((p) => Number.isInteger(p) && p > 0));
  for (let added = true; added;) {
    added = false;
    for (const p of all) if (!tree.has(p.pid) && tree.has(p.ppid)) { tree.add(p.pid); added = true; }
  }
  const processes = all
    .filter((p) => p.pid !== process.pid && (tree.has(p.pid) || POSIX_NAME.test(p.name)))
    .map((p) => ({ ...p, inServerTree: tree.has(p.pid) }));
  return { processes, total: all.length, source: "ps -A" };
}

/** One process sample; `serverPids` are the tree roots (the sidecar's or our own server's pid). */
export async function sampleProcesses(serverPids = []) {
  const t0 = Date.now();
  const res = IS_WIN ? await winSample(serverPids) : await posixSample(serverPids);
  return { at: new Date().toISOString(), queryMs: Date.now() - t0, ...res };
}

function readSmall(file, max = 400) {
  try {
    return fs.readFileSync(file, "utf8").slice(0, max).trim();
  } catch (e) {
    return e.code === "ENOENT" ? null : `(unreadable: ${e.code ?? e.message})`;
  }
}

function listRefs(dir, prefix = "") {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.isDirectory()) out = out.concat(listRefs(path.join(dir, e.name), `${prefix}${e.name}/`));
    else out.push({ ref: `${prefix}${e.name}`, sha: readSmall(path.join(dir, e.name), 80) });
  }
  return out;
}

/** What is on disk at the folder project.init is making. */
export function folderState(root) {
  const s = { at: new Date().toISOString(), root, exists: false };
  try {
    const st = fs.statSync(root);
    s.exists = true;
    s.isDir = st.isDirectory();
    s.entries = s.isDir ? fs.readdirSync(root).slice(0, 30) : [];
  } catch (e) {
    if (e.code !== "ENOENT") s.error = e.code ?? e.message;
    return s;
  }
  const git = path.join(root, ".git");
  s.git = { exists: fs.existsSync(git) };
  if (s.git.exists) {
    s.git.head = readSmall(path.join(git, "HEAD"));
    s.git.refsHeads = listRefs(path.join(git, "refs", "heads"));
    s.git.packedRefs = readSmall(path.join(git, "packed-refs"));
    s.git.locks = ["index.lock", "HEAD.lock", "config.lock"].filter((f) => fs.existsSync(path.join(git, f)));
    try { s.git.entries = fs.readdirSync(git); } catch { /* racing git */ }
  }
  return s;
}

/** Runs git like apps/server/src/vcs/git.ts does (execFile, no windowsHide, GIT_TERMINAL_PROMPT=0). */
function runGitLikeServer(argv, cwd, timeoutMs) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = execFile("git", argv, { cwd, encoding: "utf8", timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }, (err, stdout, stderr) => {
      resolve({
        argv: ["git", ...argv], ms: Date.now() - t0, pid: child.pid ?? null,
        exitCode: err === null ? 0 : (typeof err.code === "number" ? err.code : null),
        signal: err?.signal ?? null, killedByTimeout: !!err?.killed && Date.now() - t0 >= timeoutMs - 50,
        ...(err && typeof err.code !== "number" ? { spawnError: String(err.code ?? err.message) } : {}),
        stdout: String(stdout ?? "").slice(0, 1000), stderr: String(stderr ?? "").slice(0, 2000),
      });
    });
  });
}

/** Git facts for this runner, taken without tide-server in the way. `scratch` must be a fresh dir the caller owns. */
export async function gitFacts(scratch, timeoutMs = 60_000) {
  const facts = { at: new Date().toISOString() };
  facts.where = IS_WIN ? await runCmd("where", ["git"], 15_000) : await runCmd("which", ["-a", "git"], 15_000);
  facts.version = await runCmd("git", ["--version"], 30_000);
  const cfg = await runCmd("git", ["config", "--list", "--show-origin"], 30_000);
  facts.config = { ...cfg, out: cfg.out.slice(0, 6000) };
  // the settings that can make `git commit` wait on something outside git
  facts.configHighlights = cfg.out.split(/\r?\n/).filter((l) => /gpg|sign|hooks|fsmonitor|core\.editor|credential|safe\.directory|longpaths|autocrlf/i.test(l)).slice(0, 40);
  facts.direct = { cwd: scratch, runs: [] };
  try {
    fs.mkdirSync(scratch, { recursive: true });
  } catch (e) {
    facts.direct.error = `cannot create ${scratch}: ${e.message}`;
    return facts;
  }
  for (const args of INIT_COMMANDS) {
    const run = await runGitLikeServer(gitArgv(args), scratch, timeoutMs);
    facts.direct.runs.push(run);
    if (run.exitCode !== 0) break;
  }
  facts.direct.after = folderState(scratch);
  return facts;
}

/** The Desktop the user would pick: the profile's Desktop and, on Windows, the shell's known folder (OneDrive may move it). */
export async function desktopCandidates() {
  const profileDesktop = path.join(os.homedir(), "Desktop");
  const out = { profileDesktop, profileDesktopExists: fs.existsSync(profileDesktop) };
  if (IS_WIN) {
    const r = await runPowerShell("[Environment]::GetFolderPath('Desktop')", 20_000);
    out.knownFolder = r.ok ? r.out.trim() : null;
    if (!r.ok) out.knownFolderError = r.error;
    out.knownFolderExists = !!out.knownFolder && fs.existsSync(out.knownFolder);
  }
  out.chosen = out.knownFolderExists ? out.knownFolder : out.profileDesktopExists ? profileDesktop : null;
  return out;
}

/** Readable lines for one process sample (summary.txt). */
export function sampleLines(sample, indent = "      ") {
  if (!sample) return [];
  if (sample.error) return [`${indent}processes: ERROR ${sample.error}`];
  const procs = sample.processes ?? [];
  const tree = procs.filter((p) => p.inServerTree);
  const gitLike = procs.filter((p) => !p.inServerTree && /^(git|gpg)/i.test(p.name ?? ""));
  const others = procs.length - tree.length - gitLike.length;
  const line = (p) => `${indent}  ${p.pid} <- ${p.ppid} ${p.name} started ${p.started ?? "?"}: ${(p.commandLine ?? "").slice(0, 300)}`;
  return [
    `${indent}processes @${sample.at} (${sample.queryMs} ms query): ${tree.length} in the server tree, ${gitLike.length} other git/gpg, ${others} other shells/conhost`,
    ...tree.map(line),
    ...gitLike.map(line),
  ];
}

/** Readable lines for one folder state. */
export function folderLines(f, indent = "      ") {
  if (!f) return [];
  if (!f.exists) return [`${indent}folder ${f.root}: does not exist${f.error ? ` (${f.error})` : ""}`];
  const g = f.git;
  const gitPart = !g?.exists
    ? "no .git"
    : `.git yes, HEAD=${JSON.stringify(g.head)}, refs/heads=${JSON.stringify((g.refsHeads ?? []).map((r) => `${r.ref}:${(r.sha ?? "").slice(0, 10)}`))}` +
      `${g.locks?.length ? `, locks=${g.locks.join(",")}` : ""}`;
  return [`${indent}folder ${f.root}: exists (${(f.entries ?? []).length} entries), ${gitPart}`];
}
