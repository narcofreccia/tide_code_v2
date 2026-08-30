import type { ServerConfig } from "./config.ts";
import { Engine } from "./orchestration/engine.ts";
import { openEventStore, type EventStore } from "./orchestration/store.ts";
import { registerBundledDrivers } from "./provider/load.ts";
import { ProviderReactor } from "./provider/reactor.ts";
import { DriverRegistry } from "./provider/registry.ts";
import { SessionDirectory } from "./provider/sessions.ts";
import { startServer, type ServerHandle } from "./rpc/server.ts";

export interface AppOptions {
  config: ServerConfig;
  /** already-open store (tests use ":memory:"); otherwise opened from config.dbPath */
  store?: EventStore;
  /** tests register fakes here; production falls back to the bundled driver packages */
  registerDrivers?: (registry: DriverRegistry) => void | Promise<void>;
  /** false keeps everything in-process without binding a socket */
  listen?: boolean;
  log?: (msg: string, data?: unknown) => void;
}

export interface App {
  config: ServerConfig;
  environmentId: string;
  store: EventStore;
  engine: Engine;
  registry: DriverRegistry;
  sessions: SessionDirectory;
  reactor: ProviderReactor;
  server: ServerHandle | undefined;
  close(): Promise<void>;
}

/**
 * Composition root: event store -> engine -> driver registry -> session directory ->
 * reactor -> RPC server. Tests build the same graph in memory with a fake driver.
 */
export async function createApp(options: AppOptions): Promise<App> {
  const { config } = options;
  const log = options.log ?? ((msg: string, data?: unknown) => console.error(msg, data));
  const store = options.store ?? (await openEventStore(config.dbPath));

  // The env id lives in the log too, so a copied database keeps its identity.
  const persisted = store.getMeta("environmentId");
  if (persisted === undefined) store.setMeta("environmentId", config.environmentId);
  const environmentId = persisted ?? config.environmentId;

  const engine = new Engine({ store });
  const registry = new DriverRegistry({ env: { dataDir: config.dataDir, log } });
  if (options.registerDrivers) await options.registerDrivers(registry);
  else await registerBundledDrivers(registry, config.providers, log);

  const sessions = new SessionDirectory({ registry, log });
  const reactor = new ProviderReactor({ engine, sessions, log });
  reactor.start();

  const server =
    options.listen === false
      ? undefined
      : await startServer({ engine, store, registry, config: { ...config, environmentId } });

  return {
    config,
    environmentId,
    store,
    engine,
    registry,
    sessions,
    reactor,
    server,
    async close() {
      reactor.stop();
      await server?.close();
      await sessions.closeAll();
      await registry.dispose();
      store.close();
    },
  };
}
