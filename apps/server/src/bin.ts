#!/usr/bin/env node
import { resolveConfig } from "./config.ts";
import { Engine } from "./orchestration/engine.ts";
import { openEventStore } from "./orchestration/store.ts";
import { startServer } from "./rpc/server.ts";

async function main(): Promise<void> {
  const config = resolveConfig(process.argv.slice(2));
  const store = await openEventStore(config.dbPath);

  // The env id lives in the log too, so a copied database keeps its identity.
  const persisted = store.getMeta("environmentId");
  if (persisted === undefined) store.setMeta("environmentId", config.environmentId);
  const environmentId = persisted ?? config.environmentId;

  const engine = new Engine({ store });
  const server = await startServer({ engine, store, config: { ...config, environmentId } });

  console.log(`tide-server listening on ws://${config.host}:${server.port}/ws (env ${environmentId})`);
  console.log(`  health: http://${config.host}:${server.port}/health`);
  if (config.dev || config.printToken) console.log(`  token: ${config.token}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\ntide-server shutting down (${signal})`);
    void server
      .close()
      .catch((err: unknown) => console.error("[shutdown] server close failed", err))
      .finally(() => {
        try {
          store.close();
        } catch (err) {
          console.error("[shutdown] db close failed", err);
        }
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
