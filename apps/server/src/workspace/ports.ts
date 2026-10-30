import { execFile } from "node:child_process";

export interface ListeningPort {
  port: number;
  pid: number;
  command: string;
  url: string;
}

/** Raw command output; injected in tests. */
export interface PortProbe {
  /** `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` output (or `ss -ltnp` when `kind` is "ss") */
  listeners(): Promise<{ kind: "lsof" | "ss"; text: string } | undefined>;
  /** `ps -axo pid=,ppid=,comm=` output */
  processes(): Promise<string | undefined>;
}

const run = (file: string, args: string[]): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" }, (err, stdout) => resolve(err === null || stdout.length > 0 ? stdout : undefined));
  });

export const systemProbe: PortProbe = {
  async listeners() {
    const lsof = await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"]);
    if (lsof !== undefined) return { kind: "lsof", text: lsof };
    const ss = await run("ss", ["-ltnp"]);
    return ss !== undefined ? { kind: "ss", text: ss } : undefined;
  },
  processes: () => run("ps", ["-axo", "pid=,ppid=,comm="]),
};

interface Listener {
  port: number;
  pid: number;
  command: string;
}

const portOfAddress = (addr: string): number | undefined => {
  const m = /:(\d+)$/.exec(addr.trim());
  return m ? Number(m[1]) : undefined;
};

/** lsof -F: `p<pid>`, `c<command>`, then one `n<addr>` per socket (e.g. `n*:3000`, `n127.0.0.1:5173`, `n[::1]:80`). */
export function parseLsof(text: string): Listener[] {
  const out: Listener[] = [];
  let pid = 0;
  let command = "";
  for (const line of text.split("\n")) {
    const tag = line[0];
    const rest = line.slice(1);
    if (tag === "p") pid = Number(rest);
    else if (tag === "c") command = rest;
    else if (tag === "n") {
      const port = portOfAddress(rest);
      if (port !== undefined && pid > 0) out.push({ port, pid, command });
    }
  }
  return out;
}

/** `ss -ltnp` rows: `LISTEN 0 511 127.0.0.1:3000 0.0.0.0:* users:(("node",pid=123,fd=19))` */
export function parseSs(text: string): Listener[] {
  const out: Listener[] = [];
  for (const line of text.split("\n")) {
    if (!line.startsWith("LISTEN")) continue;
    const cols = line.trim().split(/\s+/);
    const port = portOfAddress(cols[3] ?? "");
    const users = /\("([^"]*)",pid=(\d+)/.exec(line);
    if (port !== undefined && users) out.push({ port, pid: Number(users[2]), command: users[1] as string });
  }
  return out;
}

/** pid -> ppid */
export function parsePs(text: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s/.exec(line);
    if (m) map.set(Number(m[1]), Number(m[2]));
  }
  return map;
}

/** True when `pid` is one of `roots` or has one as an ancestor. */
function underRoots(pid: number, parents: Map<number, number>, roots: Set<number>): boolean {
  for (let cur: number | undefined = pid, hops = 0; cur !== undefined && cur > 1 && hops < 64; cur = parents.get(cur), hops++) {
    if (roots.has(cur)) return true;
  }
  return false;
}

export interface PortsOptions {
  probe?: PortProbe;
  now?: () => number;
  ttlMs?: number;
}

/**
 * Listening TCP ports owned by a descendant of the given root pids. Only terminal (pty) shells are
 * known as roots today: the harness processes are not exposed by `SessionDirectory`, so a dev server
 * the agent starts itself shows up only when it runs in one of the thread's terminals.
 * The two system calls are cached for 3 s and shared by all threads.
 */
export class PortLister {
  #probe: PortProbe;
  #now: () => number;
  #ttl: number;
  #cache: { at: number; value: Promise<{ listeners: Listener[]; parents: Map<number, number> }> } | undefined;

  constructor(options: PortsOptions = {}) {
    this.#probe = options.probe ?? systemProbe;
    this.#now = options.now ?? Date.now;
    this.#ttl = options.ttlMs ?? 3000;
  }

  #snapshot(): Promise<{ listeners: Listener[]; parents: Map<number, number> }> {
    const t = this.#now();
    if (this.#cache !== undefined && t - this.#cache.at < this.#ttl) return this.#cache.value;
    const value = (async () => {
      const [l, p] = await Promise.all([this.#probe.listeners(), this.#probe.processes()]);
      const listeners = l === undefined ? [] : l.kind === "lsof" ? parseLsof(l.text) : parseSs(l.text);
      return { listeners, parents: p === undefined ? new Map<number, number>() : parsePs(p) };
    })();
    this.#cache = { at: t, value };
    return value;
  }

  async list(rootPids: number[]): Promise<ListeningPort[]> {
    if (rootPids.length === 0) return [];
    const roots = new Set(rootPids);
    const { listeners, parents } = await this.#snapshot();
    const seen = new Set<number>();
    const out: ListeningPort[] = [];
    for (const l of listeners) {
      if (seen.has(l.port) || !underRoots(l.pid, parents, roots)) continue;
      seen.add(l.port);
      out.push({ port: l.port, pid: l.pid, command: l.command, url: `http://127.0.0.1:${l.port}` });
    }
    return out.sort((a, b) => a.port - b.port);
  }
}
