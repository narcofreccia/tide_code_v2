#!/usr/bin/env node
import { runMcpServer } from "@tide/tide-mcp";
import { createApp } from "./app.ts";
import { resolveConfig } from "./config.ts";

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // `--mcp` turns this same binary into the Tide MCP stdio server. The bun-compiled
  // sidecar has no `packages/` on disk, so provider sessions re-exec it this way.
  if (argv.includes("--mcp")) {
    await runMcpServer();
    return;
  }
  const config = resolveConfig(argv);
  const app = await createApp({ config });
  const port = app.server?.port ?? config.port;

  console.log(`tide-server listening on ws://${config.host}:${port}/ws (env ${app.environmentId})`);
  console.log(`  health: http://${config.host}:${port}/health`);
  console.log(`  providers: ${app.registry.list().join(", ") || "none"}`);
  if (config.dev || config.printToken) console.log(`  token: ${config.token}`);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\ntide-server shutting down (${signal})`);
    void app
      .close()
      .catch((err: unknown) => console.error("[shutdown] failed", err))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
