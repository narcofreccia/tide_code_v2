import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { codexDriver } from "../src/index.ts";

/**
 * Real end-to-end turn against the installed, logged-in `codex`. Off by default because it
 * spends tokens and needs a login:  TIDE_LIVE=1 pnpm --filter @tide/driver-codex test
 */
const live = process.env["TIDE_LIVE"] === "1" ? describe : describe.skip;

live("codex driver (live)", () => {
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (message) => logs.push(message) };

  it("reports an installed, logged-in provider with harness-supplied models", async () => {
    const instance = await codexDriver.create(codexDriver.defaultConfig(), env);
    const status = await instance.status();
    expect(status.kind).toBe("codex");
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.models.length).toBeGreaterThan(0);
    expect(status.models.every((model) => model.id !== "")).toBe(true);
    expect(status.caps.planMode).toBe(true);
    // second call is served from the 60s cache
    expect(await instance.status()).toBe(status);
    await instance.dispose();
  }, 120_000);

  it("runs one real turn and settles", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tide-codex-live-"));
    writeFileSync(join(cwd, "hello.txt"), "hello from tide\n");
    const instance = await codexDriver.create(codexDriver.defaultConfig(), env);
    const session = await instance.openSession({
      threadId: "live",
      cwd,
      mode: "auto-accept-edits",
      interaction: "default",
      mcpServers: [],
    });

    expect(session.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);

    const events: NormalizedEvent[] = [];
    for await (const event of session.send({ text: "Reply with exactly: codex-ok" })) events.push(event);

    const settled = events.at(-1);
    if (settled?.type !== "settled") throw new Error(`last event was ${settled?.type}`);
    expect(settled.status).toBe("completed");

    const text = events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : [])).join("");
    expect(text).toContain("codex-ok");
    expect(events.some((event) => event.type === "usage" && event.usage !== undefined)).toBe(true);

    expect(instance.terminalCommand(session.nativeSessionId!, cwd)).toContain("codex resume");
    await session.close();
    await instance.dispose();
  }, 180_000);
});
