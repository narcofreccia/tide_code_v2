import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { OpencodeConfig } from "./types.ts";

const run = promisify(execFile);

export async function exec(file: string, args: string[], timeout = 10_000): Promise<string | undefined> {
  try {
    const { stdout } = await run(file, args, { timeout, encoding: "utf8" });
    return stdout;
  } catch {
    return undefined;
  }
}

/**
 * The `opencode` to run. A configured `binaryPath` wins. Otherwise every candidate is
 * considered — `~/.opencode/bin/opencode` (the curl installer), each `opencode` on PATH and
 * `opencode2` (the second bin name `@opencode/cli` 2.x installs) — and the first 2.x one is
 * picked, so a stale 1.x install earlier in the list does not shadow a 2.x one. With no 2.x
 * candidate the first one found is returned, and the version gate reports it.
 */
export async function detectBinary(config: OpencodeConfig): Promise<string | undefined> {
  if (config.binaryPath && existsSync(config.binaryPath)) return config.binaryPath;
  const candidates: string[] = [];
  const installed = join(homedir(), ".opencode", "bin", "opencode");
  if (existsSync(installed)) candidates.push(installed);
  for (const name of ["opencode", "opencode2"]) {
    const which = await exec("/usr/bin/env", ["which", "-a", name], 5_000);
    for (const line of which?.split("\n") ?? []) {
      const path = line.trim();
      if (path !== "" && !candidates.includes(path)) candidates.push(path);
    }
  }
  for (const candidate of candidates) if ((majorOf(await binaryVersion(candidate)) ?? 0) >= 2) return candidate;
  return candidates[0];
}

/**
 * `opencode --version`: 2.x prints `opencode v2.0.27`; 1.x prints a models.dev log line and
 * then the bare version (`1.1.36`). Both end in the version.
 */
export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)\s*$/.exec(output.trim())?.[1] ?? /(\d+\.\d+\.\d+)/.exec(output.trim())?.[1];
}

export function majorOf(version: string | undefined): number | undefined {
  const major = version === undefined ? NaN : Number.parseInt(version, 10);
  return Number.isFinite(major) ? major : undefined;
}

/**
 * The upgrade hint for a 1.x binary. OpenCode 2 ships as `@opencode/cli` on npm (bins
 * `opencode`/`opencode2`); `upgrade --major` is the path the task brief names but it is not
 * in 1.1.36's `upgrade --help`, so the npm route is given as well.
 */
export function upgradeHint(found: string): string {
  return `OpenCode 2.x required, found ${found} — run \`opencode upgrade --major\` (or \`npm i -g @opencode/cli\`), or point Tide at a 2.x binary`;
}

/** Throws the upgrade hint unless `version` is 2.x or newer (unknown versions are let through). */
export function assertV2(version: string | undefined): void {
  const major = majorOf(version);
  if (major !== undefined && major < 2) throw new Error(upgradeHint(version ?? "unknown"));
}

const versions = new Map<string, Promise<string | undefined>>();

/** `<binary> --version`, memoised per path + mtime, so an in-place upgrade is noticed. */
export function binaryVersion(binary: string): Promise<string | undefined> {
  let stamp = "";
  try {
    stamp = String(statSync(binary).mtimeMs);
  } catch {
    // missing file: exec fails and the version is unknown
  }
  const key = `${binary}\0${stamp}`;
  let pending = versions.get(key);
  if (pending === undefined) {
    pending = exec(binary, ["--version"], 20_000).then((output) => parseVersion(output ?? ""));
    versions.set(key, pending);
  }
  return pending;
}
