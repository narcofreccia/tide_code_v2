import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { readLines, parseJson } from "./files.ts";

/** A session's `cost-state` totals in file order; undefined when no transcript was found. */
export type CostStateReader = (sessionId: string) => Promise<number[] | undefined>;

/**
 * Where Claude Code keeps transcripts: `CLAUDE_CONFIG_DIR` (else `~/.claude`) plus the home of
 * every extra Claude account the user added as an instance. Duplicates are dropped.
 */
export function claudeConfigDirs(home: string, env: NodeJS.ProcessEnv, instanceHomes: readonly string[] = []): string[] {
  const dirs = [env["CLAUDE_CONFIG_DIR"], join(home, ".claude"), ...instanceHomes].filter((d): d is string => d !== undefined && d.length > 0);
  return [...new Set(dirs)];
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** `<dir>/projects/<any project>/<sessionId>.jsonl`: the session may have run from any worktree. */
export async function findTranscript(sessionId: string, configDirs: readonly string[]): Promise<string | undefined> {
  // a session id is a uuid; anything else must not walk the file system
  if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
  for (const dir of configDirs) {
    const projects = join(dir, "projects");
    let names: string[];
    try {
      names = await readdir(projects);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(projects, name, `${sessionId}.jsonl`);
      if (await isFile(path)) return path;
    }
  }
  return undefined;
}

/** Streams the transcript and keeps only `{"type":"cost-state","totalCostUSD":…}` lines. */
export async function readCostStateTotals(path: string): Promise<number[]> {
  const totals: number[] = [];
  for await (const line of readLines(path)) {
    if (!line.includes('"cost-state"')) continue;
    const o = parseJson(line);
    if (o?.["type"] !== "cost-state") continue;
    const total = o["totalCostUSD"];
    if (typeof total === "number" && Number.isFinite(total)) totals.push(total);
  }
  return totals;
}

export function costStateReader(configDirs: readonly string[]): CostStateReader {
  return async (sessionId) => {
    const path = await findTranscript(sessionId, configDirs);
    return path === undefined ? undefined : readCostStateTotals(path);
  };
}
