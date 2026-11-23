// Server contexts for scripts/server-rpc-probe.mjs.
//   sidecar: the installed desktop app with a scratch TIDE_HOME, launched as
//            scripts/desktop-ui-smoke.mjs launches it (detached, no stdio, cwd = install dir), so
//            tide-server is the console-less child Tauri spawns; its port comes from the line the
//            server writes to <TIDE_HOME>/logs/server.log.
//   console: tide-server started by this script, as release-windows.yml's smoke step does
//            (`tide-server.exe --dev --port N`, stdout/stderr to a file), with its own TIDE_HOME
//            and --data; on Windows it shares this script's console.
// findAppExe and the "listening" pattern are copies of desktop-ui-smoke.mjs's: importing that
// module runs its main(). The kill is desktop-ui-smoke-win.mjs's winKill on Windows.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { IS_WIN, winKill } from "./desktop-ui-smoke-win.mjs";

export const SERVER_LISTENING = /tide-server listening on \S*?:(\d+)\//;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The main exe is the .exe beside tide-server*.exe that is neither the sidecar nor an uninstaller. */
export function findAppExe(dir) {
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => /\.exe$/i.test(f) && !/^tide-server/i.test(f) && !/unins/i.test(f))
    .map((f) => ({ file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (candidates.length === 0) throw new Error(`no app .exe found in ${dir}`);
  return candidates[0].file;
}

/** tide-server*.exe in the install dir. */
export function findServerExe(dir) {
  const f = fs.readdirSync(dir).find((n) => /^tide-server.*\.exe$/i.test(n));
  if (!f) throw new Error(`no tide-server*.exe in ${dir}`);
  return path.join(dir, f);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

export const serverLogOf = (home) => path.join(home, "logs", "server.log");

function watchChild(child, ctx) {
  child.on("error", (e) => ctx.notes.push(`spawn error: ${e.message}`));
  child.on("exit", (code, signal) => {
    ctx.exited = { code, signal, at: new Date().toISOString() };
    ctx.notes.push(`launched process ${child.pid} exited (code ${code}, signal ${signal})`);
  });
}

/** The desktop app, exactly as desktop-ui-smoke.mjs's launchApp spawns it (minus the WebView2 debugging flags). */
export function launchSidecar(exe, home, ctx) {
  const env = { ...process.env, TIDE_HOME: home };
  const child = spawn(exe, [], { detached: true, stdio: "ignore", env, cwd: path.dirname(exe) });
  watchChild(child, ctx);
  child.unref();
  ctx.launch = { kind: "sidecar", exe, pid: child.pid, cwd: path.dirname(exe) };
  return child;
}

/** tide-server itself: `<exe> [prefix…] --dev --port N --host 127.0.0.1 --data <home>/data`, output to <home>/logs/server.log. */
export function launchConsole(exe, prefixArgs, home, port, extraEnv, ctx) {
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  const fd = fs.openSync(serverLogOf(home), "a");
  const args = [...prefixArgs, "--dev", "--port", String(port), "--host", "127.0.0.1", "--data", path.join(home, "data")];
  const env = { ...process.env, ...extraEnv, TIDE_HOME: home };
  // Windows: not detached, so the server shares this script's console (detached would give it a new one)
  const child = spawn(exe, args, { detached: !IS_WIN, stdio: ["ignore", fd, fd], env, cwd: path.dirname(exe) });
  fs.closeSync(fd);
  watchChild(child, ctx);
  ctx.launch = { kind: "console", exe, args, pid: child.pid, extraEnv: Object.keys(extraEnv) };
  return child;
}

/** Waits for the "listening" line in the server log (only text after `offset`); resolves { port, ms } or { error }. */
export async function waitListening(home, deadline, ctx, offset = 0) {
  const log = serverLogOf(home);
  const t0 = Date.now();
  while (Date.now() < deadline) {
    if (fs.existsSync(log)) {
      const text = fs.readFileSync(log, "utf8").slice(offset);
      const m = SERVER_LISTENING.exec(text);
      if (m) return { port: Number(m[1]), ms: Date.now() - t0 };
    }
    if (ctx.exited && ctx.launch?.kind === "console") return { error: `the server exited before listening (${JSON.stringify(ctx.exited)})`, ms: Date.now() - t0 };
    await sleep(250);
  }
  return { error: `no "tide-server listening on" line in ${log} in time`, ms: Date.now() - t0 };
}

/** <home>/server.json's token (the server writes it on first start). */
export async function readToken(file, deadline) {
  while (true) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (typeof raw.token === "string") return { token: raw.token, environmentId: raw.environmentId };
    } catch { /* not written yet */ }
    if (Date.now() >= deadline) return { error: `no token in ${file}` };
    await sleep(250);
  }
}

/** <home>/runtime.json's pid: the tide-server process itself (under the sidecar, the app's child). */
export function readRuntimePid(home) {
  try {
    const pid = JSON.parse(fs.readFileSync(path.join(home, "runtime.json"), "utf8")).pid;
    return Number.isInteger(pid) ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Kills what a context launched (the whole tree); never anything this script did not start, except leftover tide-server on Windows (winKill). */
export async function killLaunched(child, exe, serverPid) {
  const steps = [];
  if (IS_WIN) {
    steps.push(...(await winKill(child?.pid, exe, 0)));
    return { steps };
  }
  for (const pid of [child?.pid, serverPid].filter(Boolean)) {
    for (const target of [-pid, pid]) {
      try {
        process.kill(target, "SIGKILL");
        steps.push({ cmd: `kill -KILL ${target}` });
      } catch (e) {
        if (e.code !== "ESRCH") steps.push({ cmd: `kill -KILL ${target}`, error: e.message });
      }
    }
  }
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && [child?.pid, serverPid].filter(Boolean).some(alive)) await sleep(200);
  return { steps, gone: ![child?.pid, serverPid].filter(Boolean).some(alive) };
}
