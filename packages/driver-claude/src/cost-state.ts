import { createReadStream } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** Cumulative token counters, summed over every model of a session. */
export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * One `{"type":"cost-state", totalCostUSD, modelUsage}` line of a session transcript: the
 * running totals the CLI saved when a process of that session ended. A later `--resume` or
 * fork restores the latest one, so its first `result` already carries them.
 */
export interface CostState {
  cost: number;
  tokens?: TokenTotals;
}

/** Reads a session's `cost-state` entries; `undefined` when the transcript cannot be read. */
export type CostStatesFn = (sessionId: string, options: { cwd: string; configDir?: string }) => Promise<CostState[] | undefined>;

interface ModelUsageEntry {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Sum of a `modelUsage` record (result frames and cost-state lines share the field names). */
export function sumModelUsage(modelUsage: Record<string, ModelUsageEntry> | undefined): TokenTotals | undefined {
  if (!modelUsage || typeof modelUsage !== "object") return undefined;
  const entries = Object.values(modelUsage);
  if (entries.length === 0) return undefined;
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const entry of entries) {
    totals.input += num(entry?.inputTokens);
    totals.output += num(entry?.outputTokens);
    totals.cacheRead += num(entry?.cacheReadInputTokens);
    totals.cacheWrite += num(entry?.cacheCreationInputTokens);
  }
  return totals;
}

/** Claude Code's project folder name for a cwd: every non-alphanumeric character becomes `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** `<configDir>/projects/<slug>/<id>.jsonl`, else any project folder holding that id (a fork from another worktree, a long cwd). */
export async function transcriptPath(sessionId: string, cwd: string, configDir: string): Promise<string | undefined> {
  const projects = join(configDir, "projects");
  const direct = join(projects, projectSlug(cwd), `${sessionId}.jsonl`);
  if (await exists(direct)) return direct;
  let dirs: string[];
  try {
    dirs = await readdir(projects);
  } catch {
    return undefined;
  }
  for (const dir of dirs) {
    const candidate = join(projects, dir, `${sessionId}.jsonl`);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/** Streams the file and parses only the lines that mention `cost-state`. */
export async function readCostStateFile(path: string): Promise<CostState[]> {
  const states: CostState[] = [];
  const lines = createInterface({ input: createReadStream(path, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"cost-state"')) continue;
    let entry: { type?: unknown; totalCostUSD?: unknown; modelUsage?: Record<string, ModelUsageEntry> };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "cost-state" || typeof entry.totalCostUSD !== "number") continue;
    const tokens = sumModelUsage(entry.modelUsage);
    states.push({ cost: entry.totalCostUSD, ...(tokens ? { tokens } : {}) });
  }
  return states;
}

/** The default reader: the session's transcript under `CLAUDE_CONFIG_DIR` (else `~/.claude`). Read-only. */
export const readCostStates: CostStatesFn = async (sessionId, options) => {
  const path = await transcriptPath(sessionId, options.cwd, options.configDir ?? join(homedir(), ".claude"));
  if (path === undefined) return undefined;
  try {
    return await readCostStateFile(path);
  } catch {
    return undefined;
  }
};
