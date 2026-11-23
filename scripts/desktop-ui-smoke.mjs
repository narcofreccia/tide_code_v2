#!/usr/bin/env node
// desktop-ui-smoke: launch the installed Tide Code desktop app with WebView2 remote debugging,
// attach over the Chrome DevTools Protocol and record what the page actually does (console,
// exceptions, network failures, navigations, service workers, screenshots), then decide whether
// the web app rendered. Zero npm dependencies, Node >= 22 (global fetch + WebSocket).
//
//   node scripts/desktop-ui-smoke.mjs --install-dir "C:/Users/me/AppData/Local/Tide Code"
//   node scripts/desktop-ui-smoke.mjs --attach-port 9333        # app/browser already running
//
// Exit 0: every snapshot of every round rendered. 1: at least one did not. 2: script error.
// The report (report.json, summary.txt, PNGs, server log tail) is always written to --out.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { IS_WIN, collectWebviewLog, evidenceLines, webviewLogPlan, windowsEvidence, winKill } from "./desktop-ui-smoke-win.mjs";

const VERSION = "1.1.0";
const CMD_TIMEOUT_MS = 5000;
const POLL_MS = 150;
const SETTLE_MS = 12_000; // past the web app's 8 s boot gate
const ATTACH_SETTLE_MS = 3000;
const RELOAD_LOAD_TIMEOUT_MS = 60_000;
const BOOT_GATE_ALERT = "Could not reach the Tide server";
const MAX_OTHER_CONSOLE = 50;
const MAX_EVENTS = 1000;
const HOSTS = ["127.0.0.1", "[::1]"]; // IPv4 and IPv6 loopback: "localhost" may resolve to either
const FALLBACK_AFTER_MS = 3000; // list answered but no page target for this long: take another target
const SILENT_AFTER_LISTEN_MS = 45_000;
const SERVER_LISTENING = /tide-server listening on/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

/** Hides session secrets in any text that may hold a URL. */
function redact(text) {
  return String(text).replace(/([?&](?:token|wsTicket)=)[\w.~%+=/-]*/g, "$1REDACTED");
}

function parseCli(argv) {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      ...Object.fromEntries(["install-dir", "app", "attach-port", "tide-home"].map((k) => [k, { type: "string" }])),
      out: { type: "string", default: "./desktop-ui-smoke-report" },
      port: { type: "string", default: "9333" },
      launches: { type: "string", default: "2" },
      "boot-timeout": { type: "string", default: "120" },
      help: { type: "boolean", default: false },
    },
  });
  const int = (name) => {
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
    return n;
  };
  const out = path.resolve(values.out);
  const opts = {
    help: values.help, out, port: int("port"), launches: int("launches"), bootTimeoutMs: int("boot-timeout") * 1000,
    attachPort: values["attach-port"] === undefined ? null : int("attach-port"),
    tideHome: values["tide-home"] ? path.resolve(values["tide-home"]) : path.join(out, "tide-home"),
    tideHomeIsDefault: !values["tide-home"],
    installDir: values["install-dir"] ?? null,
    app: values.app ?? null,
  };
  if (!opts.help && opts.attachPort === null && !opts.installDir && !opts.app) {
    throw new Error("pass --install-dir <dir>, --app <exe> or --attach-port <port>");
  }
  return opts;
}

/** The main exe is the .exe beside tide-server*.exe that is neither the sidecar nor an uninstaller. */
function findAppExe(dir) {
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => /\.exe$/i.test(f) && !/^tide-server/i.test(f) && !/unins/i.test(f))
    .map((f) => ({ file: path.join(dir, f), size: fs.statSync(path.join(dir, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (candidates.length === 0) throw new Error(`no app .exe found in ${dir}`);
  return { exe: candidates[0].file, candidates: candidates.map((c) => c.file) };
}

function errorText(e) {
  const c = e?.cause;
  return `${e?.name}: ${e?.message}${c ? ` (cause ${c.code ?? c.name}: ${c.message})` : ""}`;
}

/** Resolves { ok, json } or { ok: false, error } — the error text is evidence, not noise. */
async function fetchJson(host, port, route) {
  try {
    const res = await fetch(`http://${host}:${port}${route}`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` };
    return { ok: true, json: await res.json() };
  } catch (e) {
    return { ok: false, error: errorText(e) };
  }
}

async function getJson(port, route, host = "127.0.0.1") {
  const r = await fetchJson(host, port, route);
  return r.ok ? r.json : null;
}

async function portAnswers(port) {
  for (const host of HOSTS) if (await getJson(port, "/json/version", host)) return true;
  return false;
}

/** page first, then webview, other, then anything debuggable that is not DevTools itself. */
function pickTarget(targets, allowFallback) {
  const usable = (Array.isArray(targets) ? targets : []).filter((t) => t.webSocketDebuggerUrl && !String(t.url).startsWith("devtools://"));
  const page = usable.find((t) => t.type === "page");
  if (page || !allowFallback) return page ? { target: page } : null;
  const alt = usable.find((t) => t.type === "webview") ?? usable.find((t) => t.type === "other") ?? usable[0];
  return alt ? { target: alt, fallback: `no page target; attached to type "${alt.type}" (${alt.url})` } : null;
}

/** Minimal CDP client: every command resolves (never rejects), with a per-command timeout. */
class Cdp {
  static connect(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const fail = (why) => (clearTimeout(timer), ws.close(), reject(new Error(why)));
      const timer = setTimeout(() => fail("websocket connect timeout"), timeoutMs);
      ws.addEventListener("open", () => (clearTimeout(timer), resolve(new Cdp(ws))));
      ws.addEventListener("error", () => fail("websocket error"));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.onEvent = () => {};
    this.onClose = () => {};
    ws.addEventListener("message", (ev) => this.#receive(ev.data));
    ws.addEventListener("close", () => {
      for (const done of this.pending.values()) done({ ok: false, error: "socket closed" });
      this.pending.clear();
      this.onClose();
    });
  }

  #receive(data) {
    let msg = {};
    try { msg = JSON.parse(typeof data === "string" ? data : Buffer.from(data).toString("utf8")); } catch {}
    if (msg.id !== undefined) {
      const done = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      done?.(msg.error ? { ok: false, error: msg.error.message ?? JSON.stringify(msg.error) } : { ok: true, result: msg.result });
    } else if (msg.method) {
      this.onEvent(msg.method, msg.params ?? {});
    }
  }

  send(method, params = {}, timeoutMs = CMD_TIMEOUT_MS) {
    if (this.ws.readyState !== WebSocket.OPEN) return Promise.resolve({ ok: false, error: "socket not open" });
    const id = this.nextId++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, timedOut: true, error: `${method} timed out after ${timeoutMs} ms` });
      }, timeoutMs);
      this.pending.set(id, (r) => (clearTimeout(timer), resolve(r)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

function isAppOrigin(url) {
  const u = URL.parse(url ?? "");
  return !!u && (u.hostname === "tauri.localhost" || u.protocol === "tauri:");
}

function consoleText(args = []) {
  return args
    .map((a) => (a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.description ?? a.unserializableValue ?? a.type))
    .join(" ");
}

const PAGE_PROBE = `(async () => {
  const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
  const squash = (s) => (s || "").replace(/\\s+/g, " ").trim();
  const root = document.getElementById("root");
  const out = {
    href: location.href,
    readyState: document.readyState,
    isSecureContext,
    rootChildren: root ? root.childElementCount : null,
    bodyText: squash(document.body && document.body.innerText).slice(0, 600),
    alerts: [...document.querySelectorAll("[role=alert]")].map((e) => squash(e.innerText || e.textContent)),
    dataset: { ...document.documentElement.dataset },
    userAgent: navigator.userAgent,
  };
  try {
    if ("serviceWorker" in navigator) {
      const regs = await within(navigator.serviceWorker.getRegistrations(), 3000);
      out.serviceWorker = {
        count: regs.length,
        controlled: navigator.serviceWorker.controller !== null,
        registrations: regs.map((r) => ({ scope: r.scope, activeScriptURL: r.active ? r.active.scriptURL : null,
          activeState: r.active ? r.active.state : null, installing: !!r.installing, waiting: !!r.waiting })),
      };
    } else out.serviceWorker = { unavailable: true };
  } catch (e) { out.serviceWorker = { error: String(e) }; }
  try { out.caches = typeof caches === "undefined" ? null : await within(caches.keys(), 3000); }
  catch (e) { out.caches = { error: String(e) }; }
  out.resources = performance.getEntriesByType("resource").slice(0, 40)
    .map((r) => ({ name: r.name, transferSize: r.transferSize, responseStatus: r.responseStatus }));
  return out;
})()`;

/** One capture round: owns the CDP attachment (re-attaching if the target goes away) and its data. */
class Round {
  constructor(name, port, outDir) {
    Object.assign(this, { name, port, outDir, t0: now(), startedAt: new Date().toISOString() });
    Object.assign(this, { cdp: null, attaching: null, stopped: false, mainUrl: null, otherConsole: 0 });
    Object.assign(this, { requestUrls: new Map(), loadWaiters: [], timings: {}, notes: [], snapshots: [] });
    Object.assign(this, { host: HOSTS[0], giveUp: () => null });
    this.poll = { attempts: 0, versionAnswers: 0, listAnswers: 0, answeredBy: {}, firstAnswerMs: null, firstListMs: null, lastError: null, lastVersion: null, lastList: null, choice: null };
    const kinds = "console exceptions log requests badResponses failedRequests navigations loads crashes dialogs attaches cdpFailures";
    this.events = Object.fromEntries(kinds.split(" ").map((k) => [k, []]));
  }

  t() { return now() - this.t0; }

  push(kind, entry) {
    const list = this.events[kind];
    if (list.length < MAX_EVENTS) list.push({ t: this.t(), ...entry });
  }

  /** Attaches to the first page target as soon as one shows up; false if none before the deadline. */
  attach(deadline) {
    this.attaching ??= this.#attachLoop(deadline).finally(() => (this.attaching = null));
    return this.attaching;
  }

  async #attachLoop(deadline) {
    while (!this.stopped && now() < deadline) {
      const reason = this.giveUp();
      if (reason) {
        this.gaveUp = reason;
        this.notes.push(`stopped polling early: ${reason}`);
        return false;
      }
      const targets = await this.#probe();
      const pick = targets && pickTarget(targets, this.t() - this.poll.firstListMs >= FALLBACK_AFTER_MS);
      if (pick) {
        const { target, fallback } = pick;
        this.poll.choice = { t: this.t(), type: target.type, url: target.url, host: this.host, fallback: fallback ?? null };
        if (fallback) this.notes.push(fallback);
        try {
          await this.#bind(await Cdp.connect(target.webSocketDebuggerUrl, 3000), target);
          return true;
        } catch (e) {
          this.push("attaches", { error: errorText(e), url: target.url, wsUrl: target.webSocketDebuggerUrl });
        }
      }
      await sleep(POLL_MS);
    }
    return false;
  }

  /** One poll of /json/version + /json/list on each loopback host until one answers. */
  async #probe() {
    const p = this.poll;
    p.attempts++;
    for (const host of HOSTS) {
      const v = await fetchJson(host, this.port, "/json/version");
      if (!v.ok) {
        p.lastError = `@${this.t()} ms ${host} /json/version: ${v.error}`;
        continue;
      }
      this.host = host;
      p.versionAnswers++;
      p.answeredBy[host] = (p.answeredBy[host] ?? 0) + 1;
      p.firstAnswerMs ??= this.t();
      p.lastVersion = v.json;
      const l = await fetchJson(host, this.port, "/json/list");
      if (!l.ok) {
        p.lastError = `@${this.t()} ms ${host} /json/list: ${l.error}`;
        return null;
      }
      p.listAnswers++;
      p.firstListMs ??= this.t();
      p.lastList = l.json;
      return l.json;
    }
    return null;
  }

  async #bind(cdp, page) {
    this.cdp = cdp;
    this.mainUrl = page.url;
    this.timings.firstAttachMs ??= this.t();
    this.push("attaches", { targetId: page.id, url: page.url });
    cdp.onEvent = (method, params) => this.#handle(method, params);
    cdp.onClose = () => {
      if (this.cdp !== cdp) return;
      this.cdp = null;
      this.push("attaches", { detached: true });
      if (!this.stopped) this.attach(now() + 30_000);
    };
    const enabled = await Promise.all(
      ["Runtime", "Log", "Network", "Page", "Inspector"].map(async (d) => [d, await cdp.send(`${d}.enable`)]),
    );
    for (const [domain, r] of enabled) if (!r.ok) this.push("cdpFailures", { command: `${domain}.enable`, error: r.error });
    const tree = await cdp.send("Page.getFrameTree");
    if (tree.ok && tree.result.frameTree?.frame?.url) this.mainUrl = tree.result.frameTree.frame.url;
  }

  #handle(method, p) {
    switch (method) {
      case "Runtime.consoleAPICalled": {
        const important = p.type === "error" || p.type === "warning" || p.type === "assert";
        if (!important && this.otherConsole++ >= MAX_OTHER_CONSOLE) return;
        const top = p.stackTrace?.callFrames?.[0];
        this.push("console", { type: p.type, text: consoleText(p.args), source: top ? `${top.url}:${top.lineNumber + 1}` : undefined });
        return;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {};
        this.push("exceptions", { text: d.text, description: d.exception?.description, url: d.url, line: d.lineNumber });
        return;
      }
      case "Log.entryAdded":
        this.push("log", { level: p.entry.level, source: p.entry.source, text: p.entry.text, url: p.entry.url });
        return;
      case "Network.requestWillBeSent":
        this.requestUrls.set(p.requestId, p.request.url);
        this.push("requests", { url: p.request.url, type: p.type, initiator: p.initiator?.type });
        return;
      case "Network.responseReceived": {
        const r = p.response;
        if (r.status >= 400 || r.fromServiceWorker) {
          this.push("badResponses", { url: r.url, status: r.status, type: p.type, fromServiceWorker: !!r.fromServiceWorker });
        }
        return;
      }
      case "Network.loadingFailed":
        this.push("failedRequests", {
          url: this.requestUrls.get(p.requestId), type: p.type, errorText: p.errorText,
          blockedReason: p.blockedReason, canceled: p.canceled,
        });
        return;
      case "Page.frameNavigated":
        if (!p.frame.parentId) {
          this.mainUrl = p.frame.url;
          this.push("navigations", { url: p.frame.url });
        }
        return;
      case "Page.loadEventFired":
        this.push("loads", {});
        for (const resolve of this.loadWaiters.splice(0)) resolve(true);
        return;
      case "Inspector.targetCrashed":
        this.push("crashes", {});
        return;
      case "Page.javascriptDialogOpening":
        this.push("dialogs", { type: p.type, message: p.message, url: p.url });
        // a blocking dialog would stall every later evaluate; accept it so recording continues
        this.send("Page.handleJavaScriptDialog", { accept: true });
        return;
    }
  }

  async send(method, params, timeoutMs) {
    if (!this.cdp && this.attaching) await this.attaching;
    if (!this.cdp) {
      this.push("cdpFailures", { command: method, error: "not attached" });
      return { ok: false, error: "not attached" };
    }
    const r = await this.cdp.send(method, params, timeoutMs);
    if (!r.ok) this.push("cdpFailures", { command: method, error: r.error, timedOut: !!r.timedOut });
    return r;
  }

  waitForLoad(timeoutMs) {
    return new Promise((resolve) => (this.loadWaiters.push(resolve), setTimeout(() => resolve(false), timeoutMs)));
  }

  async waitFor(predicate, deadline) {
    while (now() < deadline && !predicate()) await sleep(POLL_MS);
    return predicate();
  }

  async snapshot(label) {
    const snap = { label, t: this.t(), mainUrl: this.mainUrl };
    const ev = await this.send("Runtime.evaluate", { expression: PAGE_PROBE, awaitPromise: true, returnByValue: true }, 10_000);
    if (!ev.ok) snap.page = { error: ev.error };
    else if (ev.result.exceptionDetails) snap.page = { error: ev.result.exceptionDetails.exception?.description ?? ev.result.exceptionDetails.text };
    else snap.page = ev.result.result.value;
    const targets = await getJson(this.port, "/json/list", this.host);
    snap.targets = targets?.map((t) => ({ type: t.type, url: t.url, title: t.title })) ?? null;
    snap.version = await getJson(this.port, "/json/version", this.host);
    const shot = await this.send("Page.captureScreenshot", { format: "png" }, 15_000);
    if (shot.ok) {
      snap.screenshot = `${this.name}-${label}.png`;
      fs.writeFileSync(path.join(this.outDir, snap.screenshot), Buffer.from(shot.result.data, "base64"));
    }
    snap.counts = {
      consoleErrors: this.events.console.filter((c) => c.type === "error").length,
      exceptions: this.events.exceptions.length,
      failedRequests: this.events.failedRequests.length,
      crashes: this.events.crashes.length,
    };
    snap.verdict = verdict(snap);
    this.snapshots.push(snap);
    return snap;
  }

  /** Records a snapshot that could not be taken at all (never attached). */
  missingSnapshot(label, reason) {
    const snap = { label, t: this.t(), mainUrl: this.mainUrl, page: { error: reason } };
    snap.verdict = { rendered: false, reasons: [reason] };
    this.snapshots.push(snap);
  }

  stop() {
    this.stopped = true;
    this.cdp?.close();
    this.cdp = null;
  }

  toJSON() {
    const { name, startedAt, timings, notes, snapshots, events, pid, exe, appOrigin, reload, poll, gaveUp, webviewLog, win } = this;
    return { name, startedAt, pid, exe, timings, appOrigin, reload, gaveUp, poll, webviewLog, win, notes, snapshots, events };
  }
}

function verdict(snap) {
  const page = snap.page ?? {};
  const url = page.href ?? snap.mainUrl;
  const reasons = [];
  if (page.error) reasons.push(`page probe failed: ${page.error}`);
  if (!isAppOrigin(url)) reasons.push(`main frame not on the app origin (${url})`);
  if (!(page.rootChildren >= 1)) reasons.push(`#root children: ${page.rootChildren ?? "none"}`);
  if (!page.bodyText) reasons.push("body text empty");
  if ((page.alerts ?? []).some((a) => a.includes(BOOT_GATE_ALERT))) reasons.push(`alert: ${BOOT_GATE_ALERT}`);
  if (snap.counts?.crashes > 0) reasons.push("target crashed");
  return { rendered: reasons.length === 0, reasons };
}

/** Kills the app, its WebView2 children and the sidecar; waits for the debugging port to go quiet. */
async function killAll(child, exe, port) {
  const steps = [];
  if (IS_WIN) steps.push(...(await winKill(child?.pid, exe, port)));
  else if (child?.pid) {
    try {
      process.kill(-child.pid, "SIGKILL"); // detached => the child leads its own process group
      steps.push({ cmd: `kill -KILL -${child.pid}` });
    } catch (e) {
      steps.push({ cmd: `kill -KILL -${child.pid}`, error: String(e.message) });
    }
  }
  const deadline = now() + 30_000;
  while (now() < deadline && (await portAnswers(port))) await sleep(500);
  return { steps, portQuiet: !(await portAnswers(port)) };
}

function launchApp(exe, port, tideHome, round, logFile) {
  // --remote-allow-origins: newer Chromium rejects DevTools WebSocket clients sending an Origin
  const flags = [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"];
  if (logFile) flags.push("--enable-logging", "--v=0", `--log-file=${logFile}`);
  const extra = [process.env.WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, ...flags].filter(Boolean).join(" ");
  round.browserArgs = extra;
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: extra, TIDE_HOME: tideHome };
  const child = spawn(exe, [], { detached: true, stdio: "ignore", env, cwd: path.dirname(exe) });
  child.on("error", (e) => round.notes.push(`spawn error: ${e.message}`));
  child.on("exit", (code, signal) => round.notes.push(`app process exited at ${round.t()} ms (code ${code}, signal ${signal})`));
  child.unref();
  return child;
}

function copyServerLog(tideHome, outDir, roundName) {
  const log = path.join(tideHome, "logs", "server.log");
  if (!fs.existsSync(log)) return null;
  const lines = fs.readFileSync(log, "utf8").split(/\r?\n/);
  const file = `${roundName}-server.log.txt`;
  fs.writeFileSync(path.join(outDir, file), redact(lines.slice(-300).join("\n")));
  return file;
}

/** Watches only what this round appends to the shared server log; returns when it first said "listening". */
function serverListenWatcher(tideHome, round) {
  const log = path.join(tideHome, "logs", "server.log");
  let offset = fs.existsSync(log) ? fs.statSync(log).size : 0;
  return () => {
    if (round.timings.serverListeningMs != null || !fs.existsSync(log)) return round.timings.serverListeningMs;
    const size = fs.statSync(log).size;
    if (size < offset) offset = 0; // rotated
    const fd = fs.openSync(log, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, buf.length, offset);
    fs.closeSync(fd);
    if (SERVER_LISTENING.test(buf.toString("utf8"))) round.timings.serverListeningMs = round.t();
    return round.timings.serverListeningMs;
  };
}

/** Settled snapshot, then a reload (the first navigation a fresh service worker controls) and another. */
async function captureSnapshots(round, settleMs, onSettled = async () => {}) {
  await sleep(settleMs);
  await round.snapshot("settled");
  await onSettled();
  const loaded = round.waitForLoad(RELOAD_LOAD_TIMEOUT_MS);
  const reload = await round.send("Page.reload", {});
  const t = round.t();
  round.reload = { sent: reload.ok, error: reload.error, loadFired: await loaded, loadMs: round.t() - t };
  await sleep(settleMs);
  await round.snapshot("after-reload");
}

async function launchRound(round, opts, exe) {
  round.exe = exe;
  const logPlan = webviewLogPlan(opts.out, round.name);
  const child = launchApp(exe, opts.port, opts.tideHome, round, logPlan.target);
  round.pid = child.pid;
  const listening = serverListenWatcher(opts.tideHome, round);
  round.giveUp = () => {
    const at = listening();
    const silent = round.poll.versionAnswers === 0 && round.poll.listAnswers === 0;
    return at != null && silent && round.t() - at >= SILENT_AFTER_LISTEN_MS
      ? `tide-server was listening at ${at} ms but the debugging port stayed silent for ${SILENT_AFTER_LISTEN_MS / 1000} s`
      : null;
  };
  const early = (async () => {
    await sleep(8000);
    if (!round.stopped) await windowsEvidence(round, "processes", "t+8s", exe);
    await sleep(Math.max(0, 15_000 - round.t()));
    if (!round.stopped) await windowsEvidence(round, "desktop", "t+15s", exe);
  })();
  try {
    const deadline = now() + opts.bootTimeoutMs;
    if (!(await round.attach(deadline))) {
      await windowsEvidence(round, "desktop", "failure", exe);
      const why = round.gaveUp ?? "no page target appeared on the debugging port before --boot-timeout";
      round.missingSnapshot("settled", why);
      return round.missingSnapshot("after-reload", "never attached");
    }
    const reached = await round.waitFor(() => isAppOrigin(round.mainUrl), deadline);
    round.appOrigin = { reached, ms: reached ? round.t() : null, url: round.mainUrl };
    await captureSnapshots(round, SETTLE_MS, () => windowsEvidence(round, "desktop", "settled", exe));
  } finally {
    await early;
    await windowsEvidence(round, "processes", "before-kill", exe);
    round.stop();
    round.timings.kill = await killAll(child, exe, opts.port);
    round.serverLog = copyServerLog(opts.tideHome, opts.out, round.name);
    if (round.serverLog) round.notes.push(`server log tail: ${round.serverLog}`);
    round.webviewLog = collectWebviewLog(logPlan, redact);
    if (!round.webviewLog.found) round.notes.push(round.webviewLog.note);
  }
}

async function attachRound(round, opts) {
  try {
    if (!(await round.attach(now() + 10_000))) {
      round.missingSnapshot("settled", `no page target on port ${opts.attachPort}`);
      return round.missingSnapshot("after-reload", "never attached");
    }
    round.appOrigin = { reached: isAppOrigin(round.mainUrl), ms: null, url: round.mainUrl };
    await captureSnapshots(round, ATTACH_SETTLE_MS);
  } finally {
    round.stop();
    const log = copyServerLog(opts.tideHome, opts.out, "attach");
    if (log) round.notes.push(`server log tail: ${log}`);
  }
}

function summarize(report) {
  const lines = [`desktop-ui-smoke ${VERSION}  ${report.platform}  ${report.startedAt}`];
  if (report.exe) lines.push(`app: ${report.exe}`);
  if (report.error) lines.push(`SCRIPT ERROR: ${report.error}`);
  for (const r of report.rounds) {
    lines.push("", `== ${r.name} ==`);
    if (r.appOrigin) lines.push(`app origin: ${r.appOrigin.reached ? `reached${r.appOrigin.ms === null ? "" : ` at ${r.appOrigin.ms} ms`}` : "NOT reached"} (url ${r.appOrigin.url})`);
    for (const n of r.notes) lines.push(`note: ${n}`);
    lines.push(...evidenceLines(r));
    for (const s of r.snapshots) {
      const p = s.page ?? {};
      const sw = p.serviceWorker ?? {};
      lines.push(
        `-- ${s.label}: ${s.verdict.rendered ? "RENDERED" : "NOT RENDERED"}`,
        `   url: ${p.href ?? s.mainUrl}`,
        `   root children: ${p.rootChildren ?? "n/a"}  readyState: ${p.readyState ?? "n/a"}  secure: ${p.isSecureContext ?? "n/a"}`,
        `   alerts: ${JSON.stringify(p.alerts ?? [])}`,
        `   service workers: ${sw.count ?? (sw.error || (sw.unavailable ? "unavailable" : "n/a"))}  controlled: ${sw.controlled ?? "n/a"}  caches: ${JSON.stringify(p.caches ?? null)}`,
        `   console errors so far: ${s.counts?.consoleErrors ?? "n/a"}  exceptions: ${s.counts?.exceptions ?? "n/a"}  failed requests: ${s.counts?.failedRequests ?? "n/a"}`,
        `   body: ${(p.bodyText ?? "").slice(0, 200)}`,
      );
      if (p.error) lines.push(`   probe error: ${p.error}`);
      if (!s.verdict.rendered) lines.push(`   why: ${s.verdict.reasons.join("; ")}`);
    }
    const ev = r.events;
    const problems = [
      ...ev.console.filter((c) => c.type === "error").map((c) => `[${c.t} ms] console.error: ${c.text}${c.source ? ` (${c.source})` : ""}`),
      ...ev.exceptions.map((x) => `[${x.t} ms] exception: ${x.description ?? x.text} (${x.url}:${x.line})`),
      ...ev.failedRequests.map((f) => `[${f.t} ms] request failed: ${f.url} ${f.errorText}${f.blockedReason ? ` blocked=${f.blockedReason}` : ""}${f.canceled ? " canceled" : ""}`),
      ...ev.crashes.map((c) => `[${c.t} ms] TARGET CRASHED`),
    ];
    lines.push(`first problems (${Math.min(problems.length, 20)} of ${problems.length}):`, ...problems.slice(0, 20).map((l) => `   ${l}`));
  }
  lines.push("", `VERDICT: ${report.verdict.pass ? "PASS" : "FAIL"}`);
  return redact(lines.join("\n")) + "\n";
}

function writeOutputs(report, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(outDir, "report.json"), redact(JSON.stringify(report, null, 2)));
  const summary = summarize(report);
  fs.writeFileSync(path.join(outDir, "summary.txt"), summary);
  process.stdout.write(summary);
}

const USAGE = `usage: node scripts/desktop-ui-smoke.mjs (--install-dir <dir> | --app <exe> | --attach-port <port>)
  [--out <dir>] [--port 9333] [--launches 2] [--boot-timeout 120] [--tide-home <dir>]`;

async function main() {
  const report = {
    script: { name: "desktop-ui-smoke", version: VERSION }, startedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`, node: process.version, argv: process.argv.slice(2),
    rounds: [], verdict: { pass: false },
  };
  let outDir = path.resolve("./desktop-ui-smoke-report");
  let code = 2;
  try {
    const opts = parseCli(process.argv.slice(2));
    if (opts.help) { console.log(USAGE); process.exit(0); }
    outDir = opts.out;
    fs.mkdirSync(outDir, { recursive: true });
    report.options = { ...opts };
    if (opts.attachPort !== null) {
      const round = new Round("attach", opts.attachPort, opts.out);
      report.rounds.push(round); // pushed first so a thrown error still reports what was recorded
      await attachRound(round, opts);
    } else {
      const found = opts.app ? { exe: path.resolve(opts.app), candidates: [] } : findAppExe(opts.installDir);
      report.exe = found.exe;
      report.exeCandidates = found.candidates;
      if (opts.tideHomeIsDefault) fs.rmSync(opts.tideHome, { recursive: true, force: true });
      fs.mkdirSync(opts.tideHome, { recursive: true });
      report.preClean = await killAll(null, found.exe, opts.port); // single-instance: nothing may be running
      for (let i = 1; i <= opts.launches; i++) {
        const round = new Round(`launch-${i}`, opts.port, opts.out);
        report.rounds.push(round);
        await launchRound(round, opts, found.exe);
      }
    }
    const failures = report.rounds.flatMap((r) => r.snapshots.filter((s) => !s.verdict.rendered).map((s) => `${r.name}/${s.label}`));
    report.verdict = { pass: failures.length === 0, failures };
    code = failures.length === 0 ? 0 : 1;
  } catch (e) {
    report.error = e?.stack ?? String(e);
    code = 2;
  } finally {
    try {
      writeOutputs(JSON.parse(JSON.stringify(report)), outDir);
    } catch (e) {
      console.error(`could not write the report: ${e?.stack ?? e}`);
      code = 2;
    }
  }
  process.exit(code);
}

main();
