import type { JudgeSite } from "@tide/contracts";
import type { EventStore } from "../orchestration/store.ts";
import type { DriverRegistry } from "../provider/registry.ts";
import type { SettingsStore } from "../settings.ts";
import { createDecisionClient, type DecisionClient, type Transport } from "./client.ts";
import { FallbackJudge } from "./fallback.ts";
import { JevBackend } from "./jevBackend.ts";
import { Judge } from "./judge.ts";
import { JudgeLedger } from "./ledger.ts";

export interface JudgeServiceOptions {
  settings: SettingsStore;
  registry: Pick<DriverRegistry, "get" | "has" | "status">;
  store: Pick<EventStore, "sideTable">;
  /** replaces the TypeSafe HTTP transport (tests) */
  transport?: Transport;
  env?: Record<string, string | undefined>;
  /** the client's pause before its one retry (tests pass a no-op) */
  sleep?: (ms: number) => Promise<void>;
  dataDir: string;
  log?: (msg: string, data?: unknown) => void;
  now?: () => number;
}

export interface JudgeService {
  judge: Judge;
  ledger: JudgeLedger;
  client: DecisionClient;
}

/**
 * Builds the judge from settings: Jev over the TypeSafe client, the user's harness as the
 * fallback, the ledger in the event-store database. Settings are read live on every ask, so a
 * toggle or gray-zone change applies at once.
 */
export function createJudgeService(options: JudgeServiceOptions): JudgeService {
  const { settings } = options;
  const log = options.log ?? (() => undefined);
  const client = createDecisionClient({
    settings,
    log,
    ...(options.env !== undefined ? { env: options.env } : {}),
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    ...(options.transport !== undefined ? { transport: options.transport } : {}),
  });
  const ledger = new JudgeLedger(options.store);
  const judge = new Judge({
    jev: new JevBackend(client),
    fallback: new FallbackJudge({ registry: options.registry, settings, dataDir: options.dataDir, ...(options.now !== undefined ? { now: options.now } : {}) }),
    ledger,
    grayZone: () => settings.get().decisions.grayZone,
    siteEnabled: (site: JudgeSite) => {
      const d = settings.get().decisions;
      return d.enabled && d.sites[site];
    },
    log,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });
  return { judge, ledger, client };
}
