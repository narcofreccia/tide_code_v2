import { describe, expect, it } from "vitest";
import type { ServerConfig } from "../config.ts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { DriverRegistry } from "../provider/registry.ts";
import { createFakeDriver } from "../provider/testing/fakeDriver.ts";
import { SettingsStore } from "../settings.ts";
import { hostFacts, pairingUrls, type UpdateRunner } from "./env.ts";
import { localHostFor } from "./remote.ts";
import { startServer } from "./server.ts";
import { WsTestClient } from "./testing/wsClient.ts";

const TOKEN = "env-test-token";
const config: ServerConfig = {
  tideHome: "/tmp/tide-env-test",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-env",
  token: TOKEN,
  host: "127.0.0.1",
  port: 0,
  dev: true,
  printToken: false,
  corsOrigins: [],
  version: "1.2.3",
  providers: {},
};

type Chunk = { kind?: string; line: string; done?: boolean; ok?: boolean };

async function boot(runUpdate?: UpdateRunner) {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  const claude = createFakeDriver("claude");
  claude.control.statusResult = { ...claude.control.statusResult, installed: true, version: "2.1.0" };
  registry.register(claude.driver);
  const settings = new SettingsStore({});
  settings.set({ environment: { name: "studio-mac", sshHost: "me@studio" } });
  const handle = await startServer({
    engine,
    store,
    registry,
    settings,
    config,
    relayState: () => ({ url: "wss://relay.example", connected: true, clientUrl: "https://relay.example/e/abc" }),
    ...(runUpdate !== undefined ? { runUpdate } : {}),
  });
  const client = await WsTestClient.open(`ws://127.0.0.1:${handle.port}/ws?token=${TOKEN}`);
  return {
    engine,
    client,
    port: handle.port,
    async close() {
      client.close();
      await handle.close();
      store.close();
    },
  };
}

/** Collects a stream's chunks until the server ends it. */
function collect(port: number, kinds?: string[]): Promise<Chunk[]> {
  return new Promise((resolve, reject) => {
    void import("ws").then(({ default: WebSocket }) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
      const chunks: Chunk[] = [];
      ws.on("open", () => ws.send(JSON.stringify({ id: "s1", method: "env.updateHarnesses", params: kinds ? { kinds } : {} })));
      ws.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { chunk?: Chunk; end?: boolean; error?: unknown };
        if (frame.error) reject(frame.error);
        if (frame.chunk) chunks.push(frame.chunk);
        if (frame.end) {
          ws.close();
          resolve(chunks);
        }
      });
    });
  });
}

describe("server.info (R9)", () => {
  it("reports name, host facts, harness versions, ssh host and relay state", async () => {
    const b = await boot();
    try {
      const info = await b.client.call<Record<string, unknown>>("server.info", {});
      expect(info).toMatchObject({
        environmentId: "env-env",
        name: "studio-mac",
        version: "1.2.3",
        sshHost: "me@studio",
        relay: { url: "wss://relay.example", connected: true, clientUrl: "https://relay.example/e/abc" },
      });
      const host = info["host"] as { cpus: number; cpuLoad: number; memTotal: number; busyThreads: number };
      expect(host.cpus).toBeGreaterThan(0);
      expect(host.cpuLoad).toBeGreaterThanOrEqual(0);
      expect(host.cpuLoad).toBeLessThanOrEqual(1);
      expect(host.memTotal).toBeGreaterThan(0);
      expect(host.busyThreads).toBe(0);
      const harnesses = info["harnesses"] as { kind: string; version?: string; installed: boolean }[];
      expect(harnesses.find((h) => h.kind === "claude")).toEqual({ kind: "claude", version: "2.1.0", installed: true });
      expect(harnesses.find((h) => h.kind === "codex")?.installed).toBe(false);
    } finally {
      await b.close();
    }
  });

  it("pairing URLs add the relay's client URL when it is connected", () => {
    const remote = { host: "0.0.0.0", port: 3777, lanUrls: ["ws://192.168.1.4:3777/ws"] };
    expect(pairingUrls(remote, { url: "wss://r", connected: true, clientUrl: "https://r/e/1" })).toEqual(["http://192.168.1.4:3777", "https://r/e/1"]);
    expect(pairingUrls({ ...remote, lanUrls: [] }, { url: "wss://r", connected: false, clientUrl: "https://r/e/1" })).toEqual(["http://127.0.0.1:3777"]);
    expect(hostFacts(3).busyThreads).toBe(3);
  });

  it("local processes dial loopback whatever the bind address", () => {
    expect(localHostFor("0.0.0.0")).toBe("127.0.0.1");
    expect(localHostFor("::")).toBe("127.0.0.1");
    expect(localHostFor("127.0.0.1")).toBe("127.0.0.1");
    expect(localHostFor("::1")).toBe("[::1]");
    expect(localHostFor("192.168.1.4")).toBe("192.168.1.4");
  });
});

describe("env.updateHarnesses", () => {
  it("runs each harness's updater, streams its lines, and re-reads the status", async () => {
    const calls: string[] = [];
    const runner: UpdateRunner = async (command, args, onLine) => {
      calls.push(`${command} ${args.join(" ")}`);
      onLine("Updating…");
      return 0;
    };
    const b = await boot(runner);
    try {
      const chunks = await collect(b.port);
      expect(calls).toEqual(["claude update"]); // only harnesses registered on this server
      expect(chunks.map((c) => c.line)).toEqual(["$ claude update", "Updating…", "claude: 2.1.0", "all harnesses updated"]);
      expect(chunks.at(-1)).toMatchObject({ done: true, ok: true });
    } finally {
      await b.close();
    }
  });

  it("refuses a harness while a thread runs on it, and reports failures", async () => {
    const runner: UpdateRunner = async () => 1;
    const b = await boot(runner);
    try {
      const project = (await b.engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
      if (project?.type !== "project.created") throw new Error("no project");
      const thread = (await b.engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
      if (thread?.type !== "thread.created") throw new Error("no thread");
      await b.engine.dispatch({ type: "turn.request", threadId: thread.thread.id, text: "hi" });
      expect(b.engine.getModel().threads[thread.thread.id]?.status).toBe("running");
      const chunks = await collect(b.port, ["claude", "codex", "acp"]);
      expect(chunks.find((c) => c.kind === "claude" && c.done)?.line).toMatch(/skipped, 1 thread/);
      expect(chunks.find((c) => c.kind === "codex" && c.done)?.line).toBe("codex: update failed (exit 1)");
      expect(chunks.find((c) => c.kind === "acp")?.ok).toBe(false);
      expect(chunks.at(-1)).toMatchObject({ done: true, ok: false });
    } finally {
      await b.close();
    }
  });
});
