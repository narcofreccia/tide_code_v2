import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerConfig } from "../config.ts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { startServer, type ServerHandle } from "../rpc/server.ts";
import { PairError, runPair } from "./pair.ts";
import { writeRuntime } from "./runtime.ts";

const TOKEN = "pair-cli-token";
let home: string;
let handle: ServerHandle;
let store: EventStore;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "tide-pair-"));
  writeFileSync(join(home, "server.json"), JSON.stringify({ environmentId: "env-pair", token: TOKEN }));
  store = new EventStore(await openDatabase(":memory:"));
  const config: ServerConfig = {
    tideHome: home, dataDir: ":memory:", dbPath: ":memory:", environmentId: "env-pair", token: TOKEN, host: "127.0.0.1",
    port: 0, dev: false, printToken: false, corsOrigins: [], version: "1.0.0", providers: {},
  };
  handle = await startServer({ engine: new Engine({ store }), store, config });
  writeRuntime(home, { pid: process.pid, host: "0.0.0.0", port: handle.port, startedAt: 0 });
});

afterAll(async () => {
  await handle.close();
  store.close();
  rmSync(home, { recursive: true, force: true });
});

describe("tide pair", () => {
  it("gets a code from the local server over loopback and prints it with a QR", async () => {
    const text = await runPair({ qr: true, env: { TIDE_HOME: home } });
    const code = /code: (\d{6})/.exec(text)?.[1];
    expect(code).toBeDefined();
    expect(text).toContain(`http://127.0.0.1:${handle.port}/#pair=${code}`);
    expect(text).toContain("█");
    // the printed code is live: a client can exchange it
    const res = await fetch(`http://127.0.0.1:${handle.port}/api/auth/pair`, { method: "POST", body: JSON.stringify({ code }) });
    expect(res.status).toBe(200);
  });

  it("explains a missing identity or a server that is not running", async () => {
    const empty = mkdtempSync(join(tmpdir(), "tide-pair-empty-"));
    try {
      await expect(runPair({ qr: false, env: { TIDE_HOME: empty } })).rejects.toThrow(/no server identity/);
      writeFileSync(join(empty, "server.json"), JSON.stringify({ environmentId: "x", token: "y" }));
      await expect(runPair({ qr: false, port: 1, env: { TIDE_HOME: empty } })).rejects.toBeInstanceOf(PairError);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
