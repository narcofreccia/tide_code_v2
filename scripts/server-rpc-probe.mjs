#!/usr/bin/env node
// server-rpc-probe: drive an installed Tide Code build's tide-server over its real WebSocket RPC
// and record where a call hangs — built for "Create project spins forever on Windows" (the
// `project.init` promise never settles). Zero npm dependencies, Node >= 22 (global fetch + WebSocket).
//
// Two contexts, probed the same way (the difference between them is evidence):
//   sidecar  the installed desktop app with a scratch TIDE_HOME; tide-server is the console-less child Tauri spawns
//   console  tide-server*.exe started by this script (`--dev --port N`, as release-windows.yml's smoke step)
// and, for a self-test against a server that is already running, `--attach <ws url> --token-file <server.json>`.
//
// Per context: server.info, fs.browse (no path, then the scratch parent), project.init under
// <profile>/tide-probe-<rand>-<ctx> and, when it exists, a second one on the Desktop; when the
// first succeeded, fs.browse of the new root, vcs.commits and vcs.baseStatus. While a
// project.init is pending, every 5 s: the git/sh/bash/gpg/conhost/tide-server processes (and the
// server's descendants), the target folder's state on disk and whether /health answers; after it,
// the same once more, the server log tail and, for a hung call, whether the socket is still open
// and whether a fresh server.info is answered (a blocked event loop vs one stuck request).
// Git facts are taken once at the start, including the server's two git command lines run directly.
//
//   node scripts/server-rpc-probe.mjs --install-dir "C:/Users/me/AppData/Local/Tide Code" --out out/rpc-probe
//   node scripts/server-rpc-probe.mjs --attach ws://127.0.0.1:3790/ws --token-file $TIDE_HOME/server.json --out out
//
// Exit 0: every project.init succeeded in every context. 1: one did not. 2: script or usage error.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { IS_WIN } from "./desktop-ui-smoke-win.mjs";
import { desktopCandidates, folderState, gitFacts, sampleProcesses } from "./server-rpc-probe-evidence.mjs";
import {
  findAppExe, findServerExe, freePort, killLaunched, launchConsole, launchSidecar, readRuntimePid, readToken, serverLogOf, waitListening,
} from "./server-rpc-probe-launch.mjs";
import { writeOutputs } from "./server-rpc-probe-report.mjs";
import { RpcSocket, health, httpBaseOf } from "./server-rpc-probe-rpc.mjs";

const VERSION = "1.0.0";
const RAND = crypto.randomBytes(4).toString("hex");
const MARK = `tide-probe-${RAND}`; // every folder this run creates carries it; nothing else is ever deleted
const SAMPLE_EVERY_MS = 5000;
const TEARDOWN_RESERVE_MS = 30_000; // kept back from each context's share for kill + log copy
const LISTEN_WAIT_MS = 60_000;
const POST_HANG_INFO_MS = 10_000;
const LOG_TAIL_LINES = 80;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();

const USAGE = `usage: node scripts/server-rpc-probe.mjs (--install-dir <dir> | --server-exe <exe> | --attach <ws url> --token-file <server.json>)
  [--out <dir>] [--contexts sidecar,console] [--budget 390] [--call-timeout 45] [--init-timeout 150]
  [--server-arg=<arg>]...   prepended to the console server's argv; use the = form for dashed values
                            (e.g. --server-exe node --server-arg=--experimental-strip-types --server-arg=<repo>/apps/server/src/bin.ts)
  [--server-env K=V]...     extra environment for the console server (e.g. PATH=<dir with a fake git>:...)
  [--auth ticket|token]     attach only (default ticket); [--server-pid <n>] [--server-log <file>] attach only
  [--profile-dir <dir>]     parent of the scratch project parents (default: the user profile, os.homedir())
  [--desktop-dir <dir>|none] the Desktop variant's parent (default: the user's Desktop when it exists)`;

function parseCli(argv) {
  const str = (k) => [k, { type: "string" }];
  const { values } = parseArgs({
    args: argv, strict: true,
    options: {
      ...Object.fromEntries(["install-dir", "server-exe", "attach", "token-file", "auth", "server-pid", "server-log", "profile-dir", "desktop-dir", "contexts"].map(str)),
      out: { type: "string", default: "./server-rpc-probe-report" },
      budget: { type: "string", default: "390" },
      "call-timeout": { type: "string", default: "45" },
      "init-timeout": { type: "string", default: "150" },
      "server-arg": { type: "string", multiple: true, default: [] },
      "server-env": { type: "string", multiple: true, default: [] },
      help: { type: "boolean", default: false },
    },
  });
  const int = (name) => {
    const n = Number(values[name]);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`--${name} must be a positive integer`);
    return n;
  };
  const opts = {
    help: values.help, out: path.resolve(values.out), budgetMs: int("budget") * 1000,
    callTimeoutMs: int("call-timeout") * 1000, initTimeoutMs: int("init-timeout") * 1000,
    installDir: values["install-dir"] ? path.resolve(values["install-dir"]) : null,
    serverExe: values["server-exe"] ? path.resolve(values["server-exe"]) : null,
    serverArgs: values["server-arg"],
    serverEnv: Object.fromEntries(values["server-env"].map((kv) => {
      const i = kv.indexOf("=");
      if (i <= 0) throw new Error(`--server-env takes KEY=VALUE (got "${kv}")`);
      return [kv.slice(0, i), kv.slice(i + 1)];
    })),
    attach: values.attach ?? null, tokenFile: values["token-file"] ? path.resolve(values["token-file"]) : null,
    auth: values.auth ?? "ticket", serverPid: values["server-pid"] ? int("server-pid") : null,
    serverLog: values["server-log"] ? path.resolve(values["server-log"]) : null,
    profileDir: path.resolve(values["profile-dir"] ?? os.homedir()),
    desktopDir: values["desktop-dir"] ?? null,
  };
  if (opts.help) return opts;
  if (!["ticket", "token"].includes(opts.auth)) throw new Error("--auth is ticket or token");
  if (opts.attach && !opts.tokenFile) throw new Error("--attach needs --token-file <server.json>");
  const defaults = opts.attach ? ["attach"] : opts.installDir ? ["sidecar", "console"] : opts.serverExe ? ["console"] : null;
  if (!defaults) throw new Error("pass --install-dir <dir>, --server-exe <exe> or --attach <ws url> --token-file <file>");
  opts.contexts = values.contexts ? values.contexts.split(",").map((s) => s.trim()).filter(Boolean) : defaults;
  for (const c of opts.contexts) {
    if (!["sidecar", "console", "attach"].includes(c)) throw new Error(`unknown context ${c}`);
    if (c === "sidecar" && !opts.installDir) throw new Error("the sidecar context needs --install-dir");
    if (c === "console" && !opts.installDir && !opts.serverExe) throw new Error("the console context needs --install-dir or --server-exe");
    if (c === "attach" && !opts.attach) throw new Error("the attach context needs --attach");
  }
  return opts;
}

class Probe {
  constructor(opts, report) {
    Object.assign(this, { opts, report, secrets: new Set(), created: [], launched: new Set() });
  }

  save() {
    this.report.elapsedMs = now() - this.report.t0;
    try { writeOutputs(this.report, this.opts.out, this.secrets); } catch (e) { console.error(`could not write the report: ${e?.message ?? e}`); }
  }

  /** Makes a folder whose name carries MARK and remembers it for cleanup. */
  makeDir(p) {
    if (!path.basename(p).includes(MARK)) throw new Error(`refusing to create ${p}: no ${MARK} in its name`);
    fs.mkdirSync(p, { recursive: true });
    this.created.push(p);
    return p;
  }

  /** A timeout for one call within the context's share of the budget; 0 = no time left. */
  timeout(ctx, nominal) {
    const left = ctx.deadline - now() - TEARDOWN_RESERVE_MS;
    return left < 2000 ? 0 : Math.min(nominal, left);
  }

  async call(ctx, label, method, params, nominal, list = ctx.calls) {
    const t = this.timeout(ctx, nominal);
    let r;
    if (t === 0) r = { label, method, params, skipped: "the probe's time budget is used up" };
    else if (!ctx.rpc?.isOpen) r = { label, method, params, skipped: `socket not open (${ctx.rpc?.readyState ?? "never opened"})` };
    else r = { label, params, ...(await ctx.rpc.call(method, params, t, ctx.lateAnswers)), ...(t < nominal ? { budgetCapped: true } : {}) };
    list.push(r);
    this.save();
    return r;
  }

  serverLogTail(ctx) {
    try {
      return fs.readFileSync(ctx.serverLog, "utf8").split(/\r?\n/).filter(Boolean).slice(-LOG_TAIL_LINES);
    } catch (e) {
      return [`(no server log at ${ctx.serverLog}: ${e.code ?? e.message})`];
    }
  }

  /** Starts (or finds) the server; fills ctx.wsUrl, token, serverPid, serverLog. */
  async start(ctx) {
    const { opts } = this;
    if (ctx.name === "attach") {
      ctx.wsUrl = opts.attach;
      ctx.serverLog = opts.serverLog ?? serverLogOf(path.dirname(opts.tokenFile));
      ctx.serverPid = opts.serverPid ?? readRuntimePid(path.dirname(opts.tokenFile));
      return this.#token(ctx, opts.tokenFile, now() + 5000);
    }
    ctx.home = this.makeDir(path.join(os.tmpdir(), `${MARK}-home-${ctx.name}`));
    ctx.serverLog = serverLogOf(ctx.home);
    const listenBy = Math.min(now() + LISTEN_WAIT_MS, ctx.deadline - TEARDOWN_RESERVE_MS);
    if (ctx.name === "sidecar") {
      ctx.exe = findAppExe(opts.installDir);
      if (IS_WIN) ctx.preClean = await killLaunched(null, ctx.exe, null); // single instance: nothing of ours may run
      ctx.child = launchSidecar(ctx.exe, ctx.home, ctx);
    } else {
      ctx.exe = opts.serverExe ?? findServerExe(opts.installDir);
      ctx.port = await freePort();
      ctx.child = launchConsole(ctx.exe, opts.serverArgs, ctx.home, ctx.port, opts.serverEnv, ctx);
    }
    this.launched.add(ctx);
    this.save();
    ctx.listening = await waitListening(ctx.home, listenBy, ctx);
    if (ctx.listening.error) throw new Error(ctx.listening.error);
    ctx.wsUrl = `ws://127.0.0.1:${ctx.listening.port}/ws`;
    ctx.serverPid = readRuntimePid(ctx.home) ?? (ctx.name === "console" ? ctx.child.pid : null);
    return this.#token(ctx, path.join(ctx.home, "server.json"), now() + 10_000);
  }

  async #token(ctx, file, deadline) {
    const t = await readToken(file, deadline);
    if (t.error) throw new Error(t.error);
    this.secrets.add(t.token);
    ctx.token = t.token;
    ctx.environmentId = t.environmentId;
  }

  /** Opens a socket the way the context's real client would; a refused ticket falls back to the dev token. */
  async connect(ctx) {
    const preferred = ctx.name === "console" ? "token" : ctx.name === "sidecar" ? "ticket" : this.opts.auth;
    ctx.connects ??= [];
    for (const auth of preferred === "ticket" ? ["ticket", "token"] : ["token", "ticket"]) {
      const r = await RpcSocket.open({ wsUrl: ctx.wsUrl, token: ctx.token, auth, secrets: this.secrets });
      ctx.connects.push({ auth, ok: r.ok, ms: r.ms, ...(r.error ? { error: r.error } : {}) });
      if (r.ok) {
        ctx.rpc = r.socket;
        ctx.auth = auth === preferred ? auth : `${auth} (after ${preferred} failed)`;
        ctx.socket = { ok: true };
        return true;
      }
    }
    ctx.socket = { ok: false, error: ctx.connects.map((c) => `${c.auth}: ${c.error}`).join("; ") };
    return false;
  }

  /** One project.init with evidence sampling while it is pending. */
  async init(ctx, label, parentPath, name) {
    const entry = { label, parentPath, name, target: path.join(parentPath, name), samples: [] };
    ctx.inits.push(entry);
    if (!ctx.rpc?.isOpen) {
      ctx.notes.push(`socket was ${ctx.rpc?.readyState ?? "never opened"} before project.init (${label}); reconnecting`);
      await this.connect(ctx);
    }
    const t = this.timeout(ctx, this.opts.initTimeoutMs);
    if (t === 0 || !ctx.rpc?.isOpen) {
      entry.call = { skipped: t === 0 ? "the probe's time budget is used up" : "socket not open" };
      this.save();
      return entry;
    }
    const t0 = now();
    const pending = ctx.rpc.call("project.init", { parentPath, name }, t, ctx.lateAnswers);
    const httpBase = httpBaseOf(ctx.wsUrl);
    let result = null;
    while (!result) {
      result = await Promise.race([pending, sleep(SAMPLE_EVERY_MS).then(() => null)]);
      if (result) break;
      const [processes, h] = await Promise.all([sampleProcesses(this.#roots(ctx)), health(httpBase)]);
      entry.samples.push({ t: now() - t0, health: h, folder: folderState(entry.target), processes });
      this.save();
    }
    entry.call = { label: `project.init (${label})`, ...result, ...(t < this.opts.initTimeoutMs ? { budgetCapped: true } : {}) };
    const after = { socketState: ctx.rpc.readyState };
    [after.processes, after.health] = await Promise.all([sampleProcesses(this.#roots(ctx)), health(httpBase)]);
    after.folder = folderState(entry.target);
    if (result.status === "timeout" && ctx.rpc.isOpen) {
      // answered = the event loop turns and only this request is stuck; silent = the loop (or the socket) is blocked
      after.postInfo = await ctx.rpc.call("server.info", {}, POST_HANG_INFO_MS, ctx.lateAnswers);
      after.socketStateAfterInfo = ctx.rpc.readyState;
    }
    after.serverLogTail = this.serverLogTail(ctx);
    entry.after = after;
    entry.lateAnswers = ctx.lateAnswers.filter((l) => l.id === result.id);
    this.save();
    return entry;
  }

  #roots(ctx) {
    return [ctx.serverPid].filter(Boolean);
  }

  async runContext(ctx) {
    try {
      await this.start(ctx);
      if (!(await this.connect(ctx))) throw new Error(`could not open the RPC socket: ${ctx.socket.error}`);
      this.save();
      const T = this.opts.callTimeoutMs;
      await this.call(ctx, "server.info", "server.info", {}, T);
      await this.call(ctx, "fs.browse (no path)", "fs.browse", {}, T);
      const parent = this.makeDir(path.join(this.opts.profileDir, `${MARK}-${ctx.name}`));
      await this.call(ctx, "fs.browse (scratch parent)", "fs.browse", { path: parent }, T);
      const first = await this.init(ctx, "profile", parent, "demo-project");
      const desktop = this.report.desktop?.chosen;
      if (desktop) {
        const target = path.join(desktop, `${MARK}-${ctx.name}`);
        this.created.push(target); // the server creates it; it carries MARK, so cleanup may remove it
        await this.init(ctx, "desktop", desktop, path.basename(target));
      } else {
        ctx.notes.push(`no Desktop variant: ${JSON.stringify(this.report.desktop)}`);
      }
      if (first.call?.status === "ok") {
        const { projectId, rootPath } = first.call.result ?? {};
        await this.call(ctx, "fs.browse (new project root)", "fs.browse", { path: rootPath }, T, ctx.followUps);
        await this.call(ctx, "vcs.commits (project)", "vcs.commits", { projectId, limit: 5 }, T, ctx.followUps);
        await this.call(ctx, "vcs.baseStatus (project)", "vcs.baseStatus", { projectId }, T, ctx.followUps);
      }
    } catch (e) {
      ctx.error = e?.stack ?? String(e);
    } finally {
      await this.stop(ctx);
    }
  }

  async stop(ctx) {
    ctx.rpc?.close();
    ctx.serverLogTailAtEnd = this.serverLogTail(ctx);
    if (this.launched.has(ctx)) {
      ctx.kill = await killLaunched(ctx.child, ctx.name === "sidecar" ? ctx.exe : null, ctx.serverPid);
      this.launched.delete(ctx);
    }
    delete ctx.child;
    delete ctx.rpc;
    this.save();
  }

  /** Removes only folders this run created (each name carries MARK), deepest first. */
  cleanup() {
    const out = [];
    for (const p of [...new Set(this.created)].reverse()) {
      if (!path.basename(p).includes(MARK)) {
        out.push({ path: p, removed: false, reason: `no ${MARK} in the name` });
        continue;
      }
      if (!fs.existsSync(p)) {
        out.push({ path: p, removed: true, note: "was not there" });
        continue;
      }
      try {
        fs.rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
        out.push({ path: p, removed: !fs.existsSync(p) });
      } catch (e) {
        out.push({ path: p, removed: false, reason: e.message });
      }
    }
    return out;
  }
}

async function main() {
  const report = {
    script: { name: "server-rpc-probe", version: VERSION }, startedAt: new Date().toISOString(), t0: now(),
    platform: `${process.platform}-${process.arch}`, node: process.version, argv: process.argv.slice(2), mark: MARK,
    contexts: [], verdict: { pass: false },
  };
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    process.exit(0);
  }
  report.options = opts;
  report.budgetSec = opts.budgetMs / 1000;
  const probe = new Probe(opts, report);
  const deadline = now() + opts.budgetMs;
  let code = 2;
  const onSignal = async (sig) => {
    // killing the server settles the pending call, so main() may finish first: it reads this flag
    probe.interrupted = true;
    report.error = `interrupted by ${sig}`;
    for (const ctx of [...probe.launched]) await probe.stop(ctx);
    report.cleanup = probe.cleanup();
    probe.save();
    process.exit(2);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    fs.mkdirSync(opts.out, { recursive: true });
    probe.save();
    report.gitFacts = await gitFacts(probe.makeDir(path.join(opts.profileDir, `${MARK}-git`)), 30_000);
    if (opts.desktopDir === "none") report.desktop = { skipped: "--desktop-dir none" };
    else if (opts.desktopDir) report.desktop = { given: path.resolve(opts.desktopDir), chosen: fs.existsSync(opts.desktopDir) ? path.resolve(opts.desktopDir) : null };
    else report.desktop = await desktopCandidates();
    probe.save();
    for (let i = 0; i < opts.contexts.length; i++) {
      // each context gets an equal share of what is left, so a hang in the first cannot starve the second
      const share = (deadline - now()) / (opts.contexts.length - i);
      const ctx = { name: opts.contexts[i], deadline: now() + share, budgetMs: Math.round(share), calls: [], inits: [], followUps: [], notes: [], lateAnswers: [] };
      report.contexts.push(ctx);
      await probe.runContext(ctx);
    }
    const inits = report.contexts.map((c) => ({ name: c.name, ok: c.inits.length > 0 && c.inits.every((i) => i.call?.status === "ok") }));
    report.verdict = { pass: inits.every((i) => i.ok), contexts: inits };
    code = report.verdict.pass ? 0 : 1;
  } catch (e) {
    report.error = e?.stack ?? String(e);
    code = 2;
  } finally {
    for (const ctx of [...probe.launched]) await probe.stop(ctx);
    report.cleanup = probe.cleanup();
    if (report.cleanup.some((c) => !c.removed)) report.verdict.cleanupIncomplete = true;
    if (probe.interrupted) code = 2;
    report.exitCode = code;
    probe.save();
  }
  process.exit(code);
}

main();
