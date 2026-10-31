import { realpath as fsRealpath } from "node:fs/promises";
import type { PtyChunk, ReadModel, RunPlan, RunPlanRow, RunRepo, RunServiceStatus, RunSession, RunSessionChunk } from "@tide/contracts";
import { RpcException } from "../rpc/router.ts";
import { within, type PortLister } from "../workspace/ports.ts";
import { killProcessTree, type TreeSignal } from "../workspace/pty/killTree.ts";
import type { PtyManager } from "../workspace/pty/manager.ts";
import { lanHost } from "./lanHost.ts";
import { planStack } from "./plan.ts";

export interface RunTimings {
  /** port readiness poll */
  pollMs: number;
  /** starting → failed{timeout} (the process is kept) */
  readyTimeoutMs: number;
  /** readiness `none`: alive this long ⇒ running */
  noneAliveMs: number;
  /** an exit sooner than this after the start is a failure, not an exit */
  fastFailMs: number;
  /** per step of SIGINT → SIGTERM → SIGKILL */
  graceMs: number;
}
export const RUN_TIMINGS: RunTimings = { pollMs: 1000, readyTimeoutMs: 60_000, noneAliveMs: 2000, fastFailMs: 5000, graceMs: 3000 };

export interface RunSupervisorDeps {
  ptys: Pick<PtyManager, "create" | "attach" | "pidOf" | "alive" | "stop">;
  ports: Pick<PortLister, "list" | "listeners">;
  /** the project's stack repos with their profiles (run/profiles.ts) */
  profilesFor(projectId: string): Promise<RunRepo[]>;
  model(): ReadModel;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** `${host}` for connects; the LAN IPv4 by default */
  host?: () => string;
  log?: (msg: string, data?: unknown) => void;
  timings?: Partial<RunTimings>;
  /** signals an external service's tree (one this server did not start) */
  killPid?: (pid: number, signal: TreeSignal) => Promise<void>;
  pidAlive?: (pid: number) => boolean;
  realpath?: (path: string) => Promise<string>;
}

export interface PlanOptions {
  selected?: string[];
  pins?: Record<string, number>;
}

const PORT_TAKEN = /Port \d+ is in use|EADDRINUSE|address already in use/i;
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const LIVE = new Set<RunServiceStatus["state"]>(["starting", "ready", "running", "external"]);
const TAIL_BYTES = 8192;

interface Svc {
  row: RunPlanRow;
  ptyId: string | undefined;
  /** bumped by stop/restart: readiness checks of an older epoch drop their result */
  epoch: number;
  startedAt: number;
  tail: string;
  stopping: boolean;
  detach: (() => void) | undefined;
}

interface ProjectRun {
  session: RunSession;
  svcs: Map<string, Svc>;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

const compileReadyPattern = (pattern: string): ((text: string) => boolean) => {
  try {
    const re = new RegExp(pattern, "i");
    return (text) => re.test(text);
  } catch {
    return (text) => text.includes(pattern);
  }
};

/**
 * Runs a project's stack: one terminal per service (owner `run:<projectId>`), readiness tracking,
 * dependency ordering and the stop escalation. Sessions are ephemeral, like the processes; on boot
 * `markExternal` adopts services still listening from a previous server life as `external`.
 */
export class RunSupervisor {
  #deps: RunSupervisorDeps;
  #t: RunTimings;
  #now: () => number;
  #sleep: (ms: number) => Promise<void>;
  #log: (msg: string, data?: unknown) => void;
  #runs = new Map<string, ProjectRun>();
  #subs = new Map<string, Set<(chunk: RunSessionChunk) => void>>();
  #waiters = new Set<() => void>();
  #inflight = new Set<Promise<unknown>>();
  #closed = false;

  constructor(deps: RunSupervisorDeps) {
    this.#deps = deps;
    this.#t = { ...RUN_TIMINGS, ...deps.timings };
    this.#now = deps.now ?? Date.now;
    this.#sleep = deps.sleep ?? realSleep;
    this.#log = deps.log ?? (() => undefined);
  }

  // ---- planning ----

  async plan(projectId: string, options: PlanOptions = {}): Promise<RunPlan> {
    const project = this.#deps.model().projects[projectId];
    if (project === undefined) throw new RpcException("not-found", `unknown project ${projectId}`);
    const repos = await this.#deps.profilesFor(projectId);
    const listening = await this.#deps.ports.listeners({ fresh: true });
    await this.#markExternal(projectId, repos, listening);

    const selected =
      options.selected ??
      project.runStack?.selected ??
      repos.flatMap((r) => (r.error === undefined ? (r.profile?.services ?? []).filter((s) => s.default !== false).map((s) => `${r.repoKey}.${s.id}`) : []));
    const pins = { ...(options.pins ?? project.runStack?.pins ?? {}) };
    const ownPorts = new Set<number>();
    const run = this.#runs.get(projectId);
    for (const [key, status] of Object.entries(run?.session.services ?? {})) {
      if (!LIVE.has(status.state)) continue;
      for (const [listen, port] of Object.entries(status.ports)) {
        ownPorts.add(port);
        // a running service keeps its port: pinned ports are claimed before movable ones
        if (!this.#isFixed(repos, key, listen)) pins[`${key}.${listen}`] = port;
      }
    }
    return planStack({ repos, selected, pins, listening, ownPorts, host: (this.#deps.host ?? lanHost)(), now: this.#now() });
  }

  #isFixed(repos: RunRepo[], key: string, listen: string): boolean {
    for (const r of repos) for (const s of r.profile?.services ?? []) if (`${r.repoKey}.${s.id}` === key) return s.listens.some((l) => l.name === listen && l.how === "fixed");
    return false;
  }

  // ---- lifecycle ----

  async start(projectId: string, options: PlanOptions & { force?: boolean } = {}): Promise<RunSession> {
    const plan = await this.plan(projectId, options);
    if (plan.status === "blocked" && options.force !== true) {
      throw new RpcException("conflict", `the stack is blocked: ${plan.conflicts.map((c) => c.reason).join("; ")}`, { conflicts: plan.conflicts });
    }
    const run = this.#ensure(projectId);
    run.session.plan = plan;
    for (const row of plan.rows) {
      if (row.blocked !== undefined) continue;
      const state = run.session.services[row.key]?.state;
      if (state !== undefined && LIVE.has(state)) continue;
      this.#launch(projectId, run, row);
    }
    return structuredClone(run.session);
  }

  /** Stops one service, or the whole stack (which also drops the session). */
  async stop(projectId: string, key?: string): Promise<void> {
    const run = this.#runs.get(projectId);
    if (run === undefined) return;
    const keys = key !== undefined ? [key] : Object.keys(run.session.services);
    if (key !== undefined && run.session.services[key] === undefined) throw new RpcException("not-found", `${key} is not running`);
    await this.#track(Promise.all(keys.map((k) => this.#stopOne(projectId, run, k))));
    if (key === undefined && this.#runs.get(projectId) === run) this.#drop(projectId);
  }

  async restart(projectId: string, key: string): Promise<RunSession> {
    const run = this.#runs.get(projectId);
    const previous = run?.session.plan;
    if (run === undefined || previous === undefined) throw new RpcException("not-found", `no run session for ${projectId}`);
    if (run.session.services[key] !== undefined) await this.#stopOne(projectId, run, key);
    const plan = await this.plan(projectId, { selected: previous.rows.map((r) => r.key) });
    const row = plan.rows.find((r) => r.key === key);
    if (row === undefined) throw new RpcException("not-found", `${key} is not in the stack`);
    if (row.blocked !== undefined) throw new RpcException("conflict", row.blocked);
    run.session.plan = { ...previous, rows: previous.rows.map((r) => (r.key === key ? row : r)) };
    this.#launch(projectId, run, row);
    return structuredClone(run.session);
  }

  get(projectId: string): RunSession | undefined {
    const run = this.#runs.get(projectId);
    return run === undefined ? undefined : structuredClone(run.session);
  }

  /** Snapshot first (an empty session when nothing runs), then deltas; `ended` when the session is dropped. */
  subscribe(projectId: string, cb: (chunk: RunSessionChunk) => void): () => void {
    let set = this.#subs.get(projectId);
    if (set === undefined) {
      set = new Set();
      this.#subs.set(projectId, set);
    }
    set.add(cb);
    const run = this.#runs.get(projectId);
    cb({ kind: "snapshot", session: run !== undefined ? structuredClone(run.session) : { projectId, startedAt: 0, services: {} } });
    return () => {
      set.delete(cb);
      if (set.size === 0) this.#subs.delete(projectId);
    };
  }

  /** Services listening on their preferred port from inside their repo, not started by us ⇒ `external`. */
  async markExternal(projectId: string): Promise<void> {
    const repos = await this.#deps.profilesFor(projectId);
    if (!repos.some((r) => (r.profile?.services.length ?? 0) > 0)) return;
    await this.#markExternal(projectId, repos, await this.#deps.ports.listeners({ fresh: true }));
  }

  /** Settles launches and stops already under way (not readiness timers or dependency waits). */
  async drain(): Promise<void> {
    while (this.#inflight.size > 0) await Promise.allSettled([...this.#inflight]);
  }

  /** Server shutdown: cancels readiness tracking. The terminals die with the PtyManager. */
  close(): void {
    this.#closed = true;
    for (const run of this.#runs.values()) {
      for (const svc of run.svcs.values()) {
        svc.epoch++;
        svc.detach?.();
      }
    }
    this.#notify();
  }

  // ---- internals ----

  #track<T>(p: Promise<T>): Promise<T> {
    this.#inflight.add(p);
    const done = (): void => void this.#inflight.delete(p);
    p.then(done, done);
    return p;
  }

  #ensure(projectId: string): ProjectRun {
    let run = this.#runs.get(projectId);
    if (run === undefined) {
      run = { session: { projectId, startedAt: this.#now(), services: {} }, svcs: new Map() };
      this.#runs.set(projectId, run);
      this.#emit(projectId, { kind: "snapshot", session: structuredClone(run.session) });
    }
    return run;
  }

  #drop(projectId: string): void {
    const run = this.#runs.get(projectId);
    if (run === undefined) return;
    for (const svc of run.svcs.values()) {
      svc.epoch++;
      svc.detach?.();
    }
    this.#runs.delete(projectId);
    this.#emit(projectId, { kind: "ended" });
    this.#notify();
  }

  #emit(projectId: string, chunk: RunSessionChunk): void {
    for (const cb of [...(this.#subs.get(projectId) ?? [])]) cb(chunk);
  }

  #notify(): void {
    for (const check of [...this.#waiters]) check();
  }

  #set(projectId: string, run: ProjectRun, key: string, status: RunServiceStatus): void {
    if (this.#runs.get(projectId) !== run) return;
    run.session.services[key] = status;
    this.#emit(projectId, { kind: "service", key, status: structuredClone(status) });
    this.#notify();
  }

  #patch(projectId: string, run: ProjectRun, key: string, patch: Partial<RunServiceStatus>): void {
    const prev = run.session.services[key];
    if (prev === undefined) return;
    const next: RunServiceStatus = { ...prev, ...patch, since: this.#now() };
    if (patch.state !== undefined && patch.state !== "failed" && patch.reason === undefined) delete next.reason;
    this.#set(projectId, run, key, next);
  }

  #current(projectId: string, run: ProjectRun, svc: Svc, epoch: number): boolean {
    return !this.#closed && this.#runs.get(projectId) === run && run.svcs.get(svc.row.key) === svc && svc.epoch === epoch;
  }

  #launch(projectId: string, run: ProjectRun, row: RunPlanRow): void {
    const prev = run.svcs.get(row.key);
    if (prev !== undefined) {
      prev.epoch++;
      prev.detach?.();
    }
    const svc: Svc = { row, ptyId: undefined, epoch: 0, startedAt: this.#now(), tail: "", stopping: false, detach: undefined };
    run.svcs.set(row.key, svc);
    const waiting = row.dependsOn.filter((d) => run.session.services[d]?.state !== "ready" && run.session.services[d]?.state !== "running" && run.session.services[d]?.state !== "external");
    this.#set(projectId, run, row.key, {
      state: "starting",
      ports: { ...row.ports },
      since: this.#now(),
      ...(waiting.length > 0 ? { reason: `waiting for ${waiting.join(", ")}` } : {}),
    });
    const epoch = svc.epoch;
    void this.#waitDeps(projectId, run, svc, epoch).then((failure) => {
      if (!this.#current(projectId, run, svc, epoch)) return;
      if (failure !== undefined) return this.#patch(projectId, run, row.key, { state: "failed", reason: failure });
      return this.#track(this.#spawn(projectId, run, svc, epoch)).catch((err: unknown) => {
        this.#log(`[run] ${row.key} failed to start`, err);
        if (this.#current(projectId, run, svc, epoch)) this.#patch(projectId, run, row.key, { state: "failed", reason: err instanceof Error ? err.message : String(err) });
      });
    });
  }

  /** Resolves undefined once every dependency is up, or the failure reason. */
  #waitDeps(projectId: string, run: ProjectRun, svc: Svc, epoch: number): Promise<string | undefined> {
    if (svc.row.dependsOn.length === 0) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const check = (): void => {
        let result: string | undefined | null = undefined;
        if (!this.#current(projectId, run, svc, epoch)) result = "cancelled";
        else {
          for (const dep of svc.row.dependsOn) {
            const state = run.session.services[dep]?.state;
            if (state === undefined) result = `dependency ${dep} was not started`;
            else if (state === "failed" || state === "exited") result = `dependency ${dep} ${state}`;
            else if (state === "starting") result ??= null;
            if (typeof result === "string") break;
          }
        }
        if (result === null) return;
        this.#waiters.delete(check);
        resolve(result);
      };
      this.#waiters.add(check);
      check();
    });
  }

  async #spawn(projectId: string, run: ProjectRun, svc: Svc, epoch: number): Promise<void> {
    const { row } = svc;
    const ptyId = await this.#deps.ptys.create({
      ownerId: `run:${projectId}`,
      cwd: row.cwd,
      cols: 120,
      rows: 30,
      env: row.env,
      // the terminal ends with the service, so its exit is the service's exit
      command: `${row.command}; exit`,
      label: row.name,
    });
    if (!this.#current(projectId, run, svc, epoch)) {
      await this.#deps.ptys.stop(ptyId, { graceMs: this.#t.graceMs });
      return;
    }
    svc.ptyId = ptyId;
    svc.startedAt = this.#now();
    const pid = this.#deps.ptys.pidOf(ptyId);
    this.#patch(projectId, run, row.key, { state: "starting", ptyId, ...(pid !== undefined ? { pid } : {}) });
    svc.detach = this.#deps.ptys.attach(ptyId, (chunk) => this.#onChunk(projectId, run, svc, chunk));

    const r = row.readiness;
    const listen = r.kind === "port" ? (r.listen ?? Object.keys(row.ports)[0]) : undefined;
    const port = listen !== undefined ? row.ports[listen] : undefined;
    if (r.kind === "none" || (r.kind === "port" && port === undefined)) {
      void this.#sleep(this.#t.noneAliveMs).then(() => {
        if (this.#current(projectId, run, svc, epoch) && this.#starting(run, row.key)) this.#patch(projectId, run, row.key, { state: "running" });
      });
      return;
    }
    void this.#sleep(this.#t.readyTimeoutMs).then(() => {
      if (this.#current(projectId, run, svc, epoch) && this.#starting(run, row.key)) this.#patch(projectId, run, row.key, { state: "failed", reason: "timeout" });
    });
    if (port !== undefined) void this.#pollPort(projectId, run, svc, epoch, port);
  }

  #starting(run: ProjectRun, key: string): boolean {
    return run.session.services[key]?.state === "starting";
  }

  async #pollPort(projectId: string, run: ProjectRun, svc: Svc, epoch: number, port: number): Promise<void> {
    for (;;) {
      await this.#sleep(this.#t.pollMs);
      if (!this.#current(projectId, run, svc, epoch) || !this.#starting(run, svc.row.key)) return;
      const pid = svc.ptyId !== undefined ? this.#deps.ptys.pidOf(svc.ptyId) : undefined;
      if (pid === undefined) return;
      const found = await this.#deps.ports.list([pid], { cwd: svc.row.cwd, fresh: true }).catch(() => []);
      if (!this.#current(projectId, run, svc, epoch) || !this.#starting(run, svc.row.key)) return;
      if (found.some((p) => p.port === port)) return this.#patch(projectId, run, svc.row.key, { state: "ready" });
    }
  }

  #onChunk(projectId: string, run: ProjectRun, svc: Svc, chunk: PtyChunk): void {
    if (this.#runs.get(projectId) !== run || run.svcs.get(svc.row.key) !== svc) return;
    const key = svc.row.key;
    if (chunk.kind === "data") {
      if (!this.#starting(run, key) || svc.stopping) return;
      svc.tail = (svc.tail + chunk.data).slice(-TAIL_BYTES);
      const text = svc.tail.replace(ANSI, "");
      if (PORT_TAKEN.test(text)) {
        this.#patch(projectId, run, key, { state: "failed", reason: "port-taken" });
        if (svc.ptyId !== undefined) void this.#track(this.#deps.ptys.stop(svc.ptyId, { graceMs: this.#t.graceMs }));
        return;
      }
      const r = svc.row.readiness;
      if (r.kind === "log" && compileReadyPattern(r.pattern)(text)) this.#patch(projectId, run, key, { state: "ready" });
      return;
    }
    if (chunk.kind !== "exit") return;
    svc.detach = undefined;
    const exit = { ...(chunk.code !== undefined ? { code: chunk.code } : {}), ...(chunk.signal !== undefined ? { signal: chunk.signal } : {}) };
    const prev = run.session.services[key];
    // the pid is gone; the ptyId stays so the UI can still open the terminal's scrollback
    const base: RunServiceStatus = {
      state: "exited",
      ports: prev?.ports ?? { ...svc.row.ports },
      since: this.#now(),
      exit,
      ...(svc.ptyId !== undefined ? { ptyId: svc.ptyId } : {}),
    };
    if (svc.stopping) return this.#set(projectId, run, key, base);
    if (prev?.state === "failed") return this.#set(projectId, run, key, { ...base, state: "failed", ...(prev.reason !== undefined ? { reason: prev.reason } : {}) });
    if (prev?.state === "starting" && this.#now() - svc.startedAt < this.#t.fastFailMs) {
      return this.#set(projectId, run, key, { ...base, state: "failed", reason: PORT_TAKEN.test(svc.tail.replace(ANSI, "")) ? "port-taken" : "exited" });
    }
    this.#set(projectId, run, key, base);
  }

  async #stopOne(projectId: string, run: ProjectRun, key: string): Promise<void> {
    const svc = run.svcs.get(key);
    const status = run.session.services[key];
    if (svc !== undefined) {
      svc.epoch++;
      svc.stopping = true;
      this.#notify();
      if (svc.ptyId !== undefined && this.#deps.ptys.alive(svc.ptyId)) {
        await this.#deps.ptys.stop(svc.ptyId, { graceMs: this.#t.graceMs });
        return;
      }
      if (status !== undefined && status.state !== "exited" && status.state !== "failed") this.#patch(projectId, run, key, { state: "exited", reason: "stopped" });
      return;
    }
    if (status?.state === "external" && status.pid !== undefined) {
      await this.#stopExternal(status.pid);
      this.#patch(projectId, run, key, { state: "exited", reason: "stopped" });
    }
  }

  async #stopExternal(pid: number): Promise<void> {
    const kill = this.#deps.killPid ?? ((p: number, s: TreeSignal) => killProcessTree(p, s));
    const alive = this.#deps.pidAlive ?? defaultPidAlive;
    const steps: TreeSignal[] = ["SIGINT", "SIGTERM", "SIGKILL"];
    for (const signal of steps) {
      if (!alive(pid)) return;
      await kill(pid, signal).catch((err: unknown) => this.#log(`[run] ${signal} ${pid} failed`, err));
      if (signal !== "SIGKILL" && alive(pid)) await this.#sleep(this.#t.graceMs);
    }
  }

  async #markExternal(projectId: string, repos: RunRepo[], listening: { port: number; pid: number; cwd?: string }[]): Promise<void> {
    const realpath = this.#deps.realpath ?? fsRealpath;
    const found = new Map<string, { pid: number; ports: Record<string, number> }>();
    for (const repo of repos) {
      if (repo.profile === undefined || repo.error !== undefined) continue;
      const root = await realpath(repo.path).catch(() => repo.path);
      for (const service of repo.profile.services) {
        for (const listen of service.listens) {
          const hit = listening.find((l) => l.port === listen.port && l.cwd !== undefined && within(l.cwd, root));
          if (hit === undefined) continue;
          const key = `${repo.repoKey}.${service.id}`;
          const entry = found.get(key) ?? { pid: hit.pid, ports: {} };
          entry.ports[listen.name] = listen.port;
          found.set(key, entry);
        }
      }
    }
    let run = this.#runs.get(projectId);
    if (run !== undefined) {
      let removed = false;
      for (const [key, status] of Object.entries(run.session.services)) {
        if (status.state === "external" && !found.has(key)) {
          delete run.session.services[key];
          removed = true;
        }
      }
      if (removed) this.#emit(projectId, { kind: "snapshot", session: structuredClone(run.session) });
    }
    for (const [key, hit] of found) {
      const state = run?.session.services[key]?.state;
      if (state === "starting" || state === "ready" || state === "running") continue;
      if (state === "external" && run?.session.services[key]?.pid === hit.pid) continue;
      run ??= this.#ensure(projectId);
      run.svcs.delete(key);
      this.#set(projectId, run, key, { state: "external", pid: hit.pid, ports: hit.ports, since: this.#now() });
    }
  }
}
