import { homedir } from "node:os";
import type { Engine } from "../orchestration/engine.ts";
import type { SettingsStore } from "../settings.ts";
import { ExternalCache, scanExternal, type ExternalResult } from "../usage/external.ts";
import { UsageIndex } from "../usage/index.ts";
import { exclusionFrom } from "../usage/ingest/dedupe.ts";
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
}

export const DEFAULT_WINDOW_MS = 30 * DAY_MS;
/** a wider window would make a cold scan read years of logs */
export const MAX_WINDOW_MS = 400 * DAY_MS;

/** `usage.summary`: Tide's turns plus (opt-in by setting) the harnesses' own local logs. */
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
}
