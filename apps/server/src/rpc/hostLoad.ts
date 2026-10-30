import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import * as nodeOs from "node:os";

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface HostLoadOptions {
  execFile?: (command: string, args: string[], timeoutMs: number) => Promise<string>;
  readFile?: (path: string) => Promise<string>;
  os?: Pick<typeof nodeOs, "cpus" | "freemem" | "loadavg" | "platform" | "totalmem">;
  now?: () => number;
}

const MEM_TTL_MS = 2000;
const CPU_MIN_INTERVAL_MS = 1000;

const realExec: NonNullable<HostLoadOptions["execFile"]> = (command, args, timeout) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { timeout, encoding: "utf8" }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** Bytes reclaimable without swapping, from `vm_stat` output: free + inactive + speculative + purgeable pages. */
export function parseVmStat(text: string): number | undefined {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  const pageSize = Number.isFinite(size) && size > 0 ? size : undefined;
  const pages = (label: string): number => Number(new RegExp(`^Pages ${label}:\\s+(\\d+)\\.?`, "m").exec(text)?.[1] ?? Number.NaN);
  const free = pages("free");
  if (!Number.isFinite(free)) return undefined;
  const extra = ["inactive", "speculative", "purgeable"].map(pages).map((n) => (Number.isFinite(n) ? n : 0));
  return (free + extra.reduce((a, b) => a + b, 0)) * (pageSize ?? 16384);
}

/** `MemAvailable` from /proc/meminfo, in bytes. */
export function parseMeminfo(text: string): number | undefined {
  const kb = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text)?.[1];
  return kb === undefined ? undefined : Number(kb) * 1024;
}

/** Fraction of busy time (0..1) between two snapshots; undefined when no time elapsed. */
export function cpuDelta(prev: CpuTimes, cur: CpuTimes): number | undefined {
  const total = cur.total - prev.total;
  if (total <= 0) return undefined;
  const idle = cur.idle - prev.idle;
  return Math.min(1, Math.max(0, (total - idle) / total));
}

export function createHostLoad(options: HostLoadOptions = {}) {
  const os = options.os ?? nodeOs;
  const exec = options.execFile ?? realExec;
  const read = options.readFile ?? ((path: string) => readFile(path, "utf8"));
  const now = options.now ?? Date.now;

  let mem: { at: number; value: number } | undefined;
  let prev: (CpuTimes & { at: number }) | undefined;
  let last: (CpuTimes & { at: number }) | undefined;
  let usage: number | undefined;

  async function readAvailable(): Promise<number> {
    const platform = os.platform();
    if (platform === "darwin") return parseVmStat(await exec("vm_stat", [], 2000)) ?? os.freemem();
    if (platform === "linux") return parseMeminfo(await read("/proc/meminfo")) ?? os.freemem();
    return os.freemem();
  }

  async function memAvailable(): Promise<number> {
    const t = now();
    if (mem !== undefined && t - mem.at < MEM_TTL_MS) return mem.value;
    const value = await readAvailable().catch(() => os.freemem());
    mem = { at: t, value };
    return value;
  }

  function snapshot(): CpuTimes {
    let idle = 0;
    let total = 0;
    for (const { times } of os.cpus()) {
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idle, total };
  }

  function loadFallback(): number {
    const load = (os.loadavg()[0] ?? 0) / Math.max(1, os.cpus().length);
    return Number.isFinite(load) ? Math.min(1, Math.max(0, load)) : 0;
  }

  function cpuUsage(): number {
    const t = now();
    if (last === undefined) {
      last = { ...snapshot(), at: t };
      return loadFallback();
    }
    if (t - last.at >= CPU_MIN_INTERVAL_MS) {
      prev = last;
      last = { ...snapshot(), at: t };
      usage = cpuDelta(prev, last) ?? usage;
    }
    return usage ?? loadFallback();
  }

  async function describeLoad(): Promise<string> {
    const gb = (n: number): string => `${Math.round(n / 2 ** 30)} GB`;
    const cores = Math.max(1, os.cpus().length);
    return `cpu ${Math.round(cpuUsage() * 100)}% (${cores} cores) · ${gb(await memAvailable())} available of ${gb(os.totalmem())}`;
  }

  return { memAvailable, cpuUsage, describeLoad };
}

const shared = createHostLoad();
export const memAvailable = shared.memAvailable;
export const cpuUsage = shared.cpuUsage;
export const describeLoad = shared.describeLoad;
