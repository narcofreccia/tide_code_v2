import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
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

export async function detectBinary(config: OpencodeConfig): Promise<string | undefined> {
  if (config.binaryPath && existsSync(config.binaryPath)) return config.binaryPath;
  const installed = join(homedir(), ".opencode", "bin", "opencode");
  if (existsSync(installed)) return installed;
  const which = await exec("/usr/bin/env", ["which", "opencode"], 5_000);
  const resolved = which?.trim().split("\n")[0]?.trim();
  return resolved !== undefined && resolved !== "" ? resolved : undefined;
}

/** `opencode --version` prints a models.dev log line before the version. */
export function parseVersion(output: string): string | undefined {
  return /(\d+\.\d+\.\d+)\s*$/.exec(output.trim())?.[1] ?? /(\d+\.\d+\.\d+)/.exec(output.trim())?.[1];
}
