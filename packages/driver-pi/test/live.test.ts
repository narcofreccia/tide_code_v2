import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { piDriver, resolveBridgePath } from "../src/index.ts";

const logs: string[] = [];
const env: DriverEnv = { dataDir: tmpdir(), log: (message) => logs.push(message) };

/**
 * Two levels of "real":
 *  - the always-on smoke spawns a real `pi --mode rpc` with the real tide-bridge and checks
 *    that the process, the NDJSON transport and the extension all load. It never calls a model,
 *    so it costs nothing and needs no login.
 *  - the TIDE_LIVE=1 block runs an actual one-turn conversation with whatever provider pi has
 *    configured:  TIDE_LIVE=1 pnpm --filter @tide/driver-pi test
 */

describe("real pi process (no model call)", () => {
  it("resolves the bridge extension that will be passed to `pi -e`", () => {
    const bridge = resolveBridgePath();
    expect(bridge).toMatch(/tide-bridge\.(js|ts)$/);
  });

  it("spawns pi, loads tide-bridge and reports a session id", async () => {
    const instance = await piDriver.create(piDriver.defaultConfig(), env);
    const status = await instance.status();
    expect(status.installed).toBe(true);
    expect(status.caps.planMode).toBe(true);

    const cwd = mkdtempSync(join(tmpdir(), "tide-pi-smoke-"));
    const session = await instance.openSession({
      threadId: "smoke",
      cwd,
      mode: "approval-required",
      interaction: "default",
      mcpServers: [],
      env: { PI_OFFLINE: "1" },
    });
    expect(session.nativeSessionId).toBeTruthy();
    expect(logs.some((line) => line.includes("extension_error"))).toBe(false);
    await session.close();
    await instance.dispose();
  }, 60_000);
});

const live = process.env["TIDE_LIVE"] === "1" ? describe : describe.skip;

live("pi driver (live)", () => {
  it("reports a logged-in provider with models from pi itself", async () => {
    const instance = await piDriver.create(piDriver.defaultConfig(), env);
    const status = await instance.status();
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.models.length).toBeGreaterThan(0);
    await instance.dispose();
  }, 120_000);

  it("runs one real turn and settles", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tide-pi-live-"));
    writeFileSync(join(cwd, "hello.txt"), "hello from tide\n");
    const instance = await piDriver.create(piDriver.defaultConfig(), env);
    const status = await instance.status();
    const model = process.env["TIDE_LIVE_MODEL"] ?? status.models.find((entry) => entry.family === "ollama")?.id ?? status.models[0]?.id;
    const session = await instance.openSession({
      threadId: "live",
      cwd,
      mode: "auto",
      interaction: "default",
      mcpServers: [],
      ...(model ? { model } : {}),
    });

    const events: NormalizedEvent[] = [];
    for await (const event of session.send({ text: "Reply with exactly the word: ready" })) events.push(event);

    const settled = events.at(-1);
    if (settled?.type !== "settled") throw new Error(`last event was ${settled?.type}`);
    expect(settled.status).toBe("completed");
    expect(events.some((event) => event.type === "assistant.delta")).toBe(true);
    expect(events.some((event) => event.type === "usage")).toBe(true);

    await session.close();
    await instance.dispose();
  }, 180_000);
});
