import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { DriverEnv, SlashCommandInfo } from "@tide/contracts";

/**
 * ACP agents announce commands only inside a session (`available_commands_update`). The last
 * list per instance is kept at `<dataDir>/acp-commands/<instanceId>.json` so the composer has
 * commands before the first session of a server run.
 */

export function commandsCachePath(env: DriverEnv): string {
  const id = (env.instance?.id ?? "acp").replace(/[^A-Za-z0-9._-]/g, "_");
  return join(env.dataDir, "acp-commands", `${id}.json`);
}

/** tmp + rename, so a reader never sees half a file. Failures are logged, never thrown. */
export function writeCommandsCache(env: DriverEnv, commands: SlashCommandInfo[]): void {
  const path = commandsCachePath(env);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(join(env.dataDir, "acp-commands"), { recursive: true });
    writeFileSync(tmp, JSON.stringify(commands));
    renameSync(tmp, path);
  } catch (error) {
    env.log(`[acp] could not cache commands: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isCommand(value: unknown): value is SlashCommandInfo {
  const entry = value as Partial<SlashCommandInfo> | null;
  return typeof entry?.name === "string" && entry.name !== "" && typeof entry.source === "string";
}

/** The cached list, or [] when there is none or it does not parse. */
export async function readCommandsCache(env: DriverEnv): Promise<SlashCommandInfo[]> {
  try {
    const list: unknown = JSON.parse(await readFile(commandsCachePath(env), "utf8"));
    return Array.isArray(list) ? list.filter(isCommand) : [];
  } catch {
    return [];
  }
}
