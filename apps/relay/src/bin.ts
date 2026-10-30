#!/usr/bin/env node
import { createRelay } from "./relay.ts";

const key = process.env["RELAY_KEY"] ?? "";
if (key.length < 16) {
  console.error("tide-relay: set RELAY_KEY to a random secret of at least 16 characters (e.g. `openssl rand -hex 32`)");
  process.exit(1);
}
const port = Number(process.env["PORT"] ?? 8787);
const host = process.env["HOST"] ?? "0.0.0.0";
const dbPath = process.env["RELAY_DB"] ?? "relay.db";

const relay = createRelay({ key, dbPath });
const bound = await relay.listen(port, host);
console.error(`tide-relay listening on ${host}:${bound} (held webhooks: ${dbPath})`);

const shutdown = (): void => {
  void relay.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
