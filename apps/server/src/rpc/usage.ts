import { homedir } from "node:os";
import { join } from "node:path";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import type { EventStore } from "../orchestration/store.ts";
import type { SettingsStore } from "../settings.ts";
import { ExternalCache, scanExternal, type ExternalResult } from "../usage/external.ts";
import { UsageIndex } from "../usage/index.ts";
import { claudeConfigDirs, costStateReader, type CostStateReader } from "../usage/ingest/costStates.ts";
import { exclusionFrom } from "../usage/ingest/dedupe.ts";
import { planRepair, REPAIR_REASON, repairTotals, scanRepairEvents } from "../usage/repair.ts";
import { summarize } from "../usage/summary.ts";
import { DAY_MS } from "../usage/types.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface UsageHandlerDeps {
  engine: Engine;
  settings?: SettingsStore;
  tideHome?: string;
  /** where `usage-index.json` lives; ":memory:" keeps it in memory */
  dataDir?: string;
  /** whose harness logs to read; tests point it at a fixture home */
  home?: string;
  now?: () => number;
  /** tests replace the scan */
  scan?: typeof scanExternal;
  /** `usage.repair` reads the stored reports from the log */
  store?: Pick<EventStore, "readAll">;
  /** tests replace the transcript reader (default: Claude's config dirs under `home`) */
  costStates?: CostStateReader;
}

export const DEFAULT_WINDOW_MS = 30 * DAY_MS;
/** a wider window would make a cold scan read years of logs */
export const MAX_WINDOW_MS = 400 * DAY_MS;

/**
 * `usage.summary`: Tide's turns plus (opt-in by setting) the harnesses' own local logs.
 * `usage.repair`: the R20 cost repair (dry run unless `apply`).
 */
export function registerUsageHandlers(router: RpcRouter, deps: UsageHandlerDeps): void {
  const now = deps.now ?? Date.now;
  const cache = new ExternalCache({ now });
  const index = new UsageIndex(deps.dataDir !== undefined ? UsageIndex.pathFor(deps.dataDir) : undefined);
  const scan = deps.scan ?? scanExternal;

  router.register("usage.summary", async (input) => {
    const t = now();
    const until = input.until ?? t;
    const since = input.since ?? until - DEFAULT_WINDOW_MS;
    if (!Number.isFinite(since) || !Number.isFinite(until) || since < 0 || until < 0) throw new RpcException("invalid-params", "since/until must be epoch milliseconds");
    if (since >= until) throw new RpcException("invalid-params", "since must be before until");
    if (until - since > MAX_WINDOW_MS) throw new RpcException("invalid-params", `window longer than ${MAX_WINDOW_MS / DAY_MS} days`);

    const model = deps.engine.getModel();
    const readLogs = deps.settings?.get().glassBox.readHarnessLogs ?? true;
    const includeExternal = input.includeExternal ?? true;
    let external: ExternalResult | undefined;
    let externalNote: string | undefined;
    if (!includeExternal) externalNote = "Spend outside Tide not requested; only Tide's turns are shown.";
    else if (!readLogs) externalNote = "Reading the harnesses' own logs is off (Settings › Glass box); only Tide's turns are shown.";
    else {
      // an open-ended window ("last 30 days") moves every call; it shares one entry per 5 minutes
      const key = input.until === undefined ? `default:${until - since}` : `${since}:${until}`;
      await index.load();
      external = await cache.get(key, () =>
        scan({
          home: deps.home ?? homedir(),
          since,
          until,
          exclusion: exclusionFrom(model, deps.tideHome),
          index,
          ...(deps.dataDir !== undefined && deps.dataDir !== ":memory:" ? { tmpDir: deps.dataDir } : {}),
        }),
      );
    }
    return summarize({
      model,
      since,
      until,
      ...(external !== undefined ? { external } : {}),
      ...(externalNote !== undefined ? { externalNote } : {}),
    });
  });

  router.register("usage.repair", async (input) => {
    if (deps.store === undefined) throw new RpcException("internal", "the event log is not available to this server");
    const home = deps.home ?? homedir();
    const instanceHomes = (deps.settings?.get().providerInstances ?? []).flatMap((p) => (p.kind === "claude" && p.home !== undefined ? [expandHome(p.home, home)] : []));
    const read = deps.costStates ?? costStateReader(claudeConfigDirs(home, process.env, instanceHomes));
    const scan = scanRepairEvents(deps.store.readAll());
    const costStates = new Map<string, number[]>();
    for (const session of scan.sessions) {
      const totals = await read(session.id).catch(() => undefined);
      if (totals !== undefined) costStates.set(session.id, totals);
    }
    const model = deps.engine.getModel();
    const rows = planRepair({ scan, costStates, titleOf: (id) => model.threads[id]?.title }).filter((r) => model.turns[r.turnId] !== undefined);
    let applied = 0;
    if (input.apply === true) {
      for (const row of rows) {
        if (row.applied || (row.evidence === "heuristic" && input.includeHeuristic !== true)) continue;
        try {
          await deps.engine.dispatch({ type: "usage.correct", turnId: row.turnId, usage: { inputTokens: 0, outputTokens: 0, costUsd: row.correctedUsd - row.storedUsd }, reason: REPAIR_REASON });
          applied++;
        } catch (err) {
          // corrected or deleted meanwhile: do not abort the rest of the repair
          if (!(err instanceof CommandError && (err.code === "conflict" || err.code === "not-found"))) throw err;
        }
        row.applied = true;
      }
    }
    return repairTotals(rows, applied);
  });
}

function expandHome(path: string, home: string): string {
  return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}
