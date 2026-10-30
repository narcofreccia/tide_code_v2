import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** Where a running server says it listens, so `tide pair` / `tide doctor` find it. */
export interface RuntimeInfo {
  pid: number;
  host: string;
  port: number;
  startedAt: number;
}

export function tideHomeOf(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env["TIDE_HOME"] ?? join(homedir(), ".tide"));
}

const fileOf = (tideHome: string): string => join(tideHome, "runtime.json");

export function writeRuntime(tideHome: string, info: RuntimeInfo): void {
  writeFileSync(fileOf(tideHome), `${JSON.stringify(info)}\n`, { mode: 0o600 });
}

export function clearRuntime(tideHome: string, pid: number = process.pid): void {
  const current = readRuntime(tideHome);
  if (current?.pid === pid) rmSync(fileOf(tideHome), { force: true });
}

export function readRuntime(tideHome: string): RuntimeInfo | undefined {
  const file = fileOf(tideHome);
  if (!existsSync(file)) return undefined;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<RuntimeInfo>;
    if (typeof raw.port !== "number" || typeof raw.host !== "string" || typeof raw.pid !== "number") return undefined;
    return { pid: raw.pid, host: raw.host, port: raw.port, startedAt: raw.startedAt ?? 0 };
  } catch {
    return undefined;
  }
}

/** The token in `<TIDE_HOME>/server.json`, or undefined when it is missing/unreadable. */
export function readToken(tideHome: string): string | undefined {
  try {
    const raw = JSON.parse(readFileSync(join(tideHome, "server.json"), "utf8")) as { token?: unknown };
    return typeof raw.token === "string" ? raw.token : undefined;
  } catch {
    return undefined;
  }
}
