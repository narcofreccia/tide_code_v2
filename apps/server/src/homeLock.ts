import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One server per TIDE_HOME. The orchestration engine is the single writer of the event store;
 * two servers on the same home run recovery, reactors and schedulers against each other's turns.
 * `<TIDE_HOME>/server.lock` names the holder; a starting server refuses while that holder is
 * alive and answers `/health` with this home's environment id, and takes a stale lock over.
 */
export interface LockInfo {
  pid: number;
  port: number;
  startedAt: number;
  version: string;
  /** the id the holder's `/health` reports (set once it listens; a copied store may differ from server.json) */
  environmentId?: string;
}

/** `tide serve` exits with this when the home is taken; the desktop shell shows it instead of restarting. */
export const HOME_IN_USE_EXIT_CODE = 75;

export class HomeInUseError extends Error {
  readonly holder: LockInfo;
  readonly tideHome: string;
  constructor(tideHome: string, holder: LockInfo) {
    super(
      `another Tide server (pid ${holder.pid}, port ${holder.port}, version ${holder.version}) already uses TIDE_HOME=${tideHome}; quit it or set TIDE_HOME to another directory`,
    );
    this.name = "HomeInUseError";
    this.holder = holder;
    this.tideHome = tideHome;
  }
}

export interface LockProbes {
  /** true while a process with this pid exists (EPERM counts as alive) */
  alive(pid: number): boolean;
  /** the environment id the server on this loopback port reports, or undefined when it does not answer */
  health(port: number): Promise<string | undefined>;
}

export const lockFileOf = (tideHome: string): string => join(tideHome, "server.lock");

export function readLock(tideHome: string): LockInfo | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(lockFileOf(tideHome), "utf8"));
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r["pid"] !== "number" || typeof r["port"] !== "number") return undefined;
  return {
    pid: r["pid"],
    port: r["port"],
    startedAt: typeof r["startedAt"] === "number" ? r["startedAt"] : 0,
    version: typeof r["version"] === "string" ? r["version"] : "unknown",
    ...(typeof r["environmentId"] === "string" ? { environmentId: r["environmentId"] } : {}),
  };
}

function readRaw(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

const serialize = (info: LockInfo): string => `${JSON.stringify(info)}\n`;

/** Is the lock's holder a live Tide server of this very home? */
async function heldBy(holder: LockInfo, environmentId: string, probes: LockProbes): Promise<boolean> {
  if (holder.pid === process.pid) return false; // our own leftover (e.g. a pid reused after a reboot)
  if (!probes.alive(holder.pid)) return false;
  const reported = await probes.health(holder.port);
  return reported !== undefined && (reported === environmentId || reported === holder.environmentId);
}

/**
 * Takes `<TIDE_HOME>/server.lock` for `info.pid` or throws `HomeInUseError`. `environmentId` is
 * the id in this home's server.json, which a live holder's `/health` must echo to count.
 * Creation uses an exclusive open, so two servers starting together cannot both win a fresh home.
 */
export async function acquireHomeLock(tideHome: string, info: LockInfo, environmentId: string, probes: LockProbes): Promise<void> {
  const file = lockFileOf(tideHome);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(file, serialize(info), { flag: "wx", mode: 0o600 });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const before = readRaw(file);
    const holder = readLock(tideHome);
    if (holder !== undefined && (await heldBy(holder, environmentId, probes))) throw new HomeInUseError(tideHome, holder);
    // stale (dead pid, reused pid, unresponsive or unreadable): remove it unless someone replaced it meanwhile
    if (readRaw(file) === before) rmSync(file, { force: true });
  }
  throw new Error(`could not take ${file}: it keeps changing under us`);
}

/** Rewrites our lock (atomic replace) once the real port and environment id are known. */
export function updateHomeLock(tideHome: string, info: LockInfo): void {
  if (readLock(tideHome)?.pid !== info.pid) return;
  const file = lockFileOf(tideHome);
  const tmp = `${file}.${info.pid}.tmp`;
  writeFileSync(tmp, serialize(info), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Removes the lock only while it still names `pid`: a server that was taken over leaves the new holder alone. */
export function releaseHomeLock(tideHome: string, pid: number = process.pid): void {
  if (readLock(tideHome)?.pid === pid) rmSync(lockFileOf(tideHome), { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** `GET http://127.0.0.1:<port>/health` with a short timeout → its environmentId. */
export async function healthEnvironmentId(port: number, timeoutMs = 1_000): Promise<string | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { ok?: unknown; environmentId?: unknown };
    return body.ok === true && typeof body.environmentId === "string" ? body.environmentId : undefined;
  } catch {
    return undefined;
  }
}

export const hostLockProbes = (): LockProbes => ({ alive: pidAlive, health: (port) => healthEnvironmentId(port) });
