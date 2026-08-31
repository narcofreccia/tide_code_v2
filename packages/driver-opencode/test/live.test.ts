import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { opencodeDriver } from "../src/index.ts";

/**
 * Real end-to-end turn against the installed, logged-in `opencode`. Off by default because
 * it spends tokens and needs a login:  TIDE_LIVE=1 pnpm --filter @tide/driver-opencode test
 */
const live = process.env["TIDE_LIVE"] === "1" ? describe : describe.skip;

live("opencode driver (live)", () => {
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (msg) => logs.push(msg) };

  it("reports an installed, logged-in provider with harness-supplied models", async () => {
    const instance = await opencodeDriver.create(opencodeDriver.defaultConfig(), env);
    const status = await instance.status();
    expect(status.kind).toBe("opencode");
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.models.length).toBeGreaterThan(0);
    expect(status.models.every((model) => model.id.includes("/"))).toBe(true);
    expect(status.caps.planMode).toBe(true);
    expect(await instance.status()).toBe(status);
    expect(instance.terminalCommand("ses_1", "/tmp/my repo")).toBe("cd '/tmp/my repo' && opencode --session ses_1");
    await instance.dispose();
  }, 120_000);

  it("runs one real turn and settles", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tide-opencode-live-"));
    writeFileSync(join(cwd, "hello.txt"), "hello from tide\n");
    const instance = await opencodeDriver.create(opencodeDriver.defaultConfig(), env);
    const session = await instance.openSession({ threadId: "live", cwd, mode: "auto", interaction: "default", mcpServers: [] });

    const events: NormalizedEvent[] = [];
    for await (const event of session.send({ text: "Reply with exactly: opencode-ok" })) events.push(event);

    const opened = events[0];
    if (opened?.type !== "session") throw new Error("first event was not `session`");
    expect(opened.nativeSessionId).toMatch(/^ses_/);
    expect(session.nativeSessionId).toBe(opened.nativeSessionId);

    const text = events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : [])).join("");
    expect(text).toContain("opencode-ok");
    expect(events.some((event) => event.type === "usage" && event.usage !== undefined)).toBe(true);

    const settled = events.at(-1);
    if (settled?.type !== "settled") throw new Error(`last event was ${settled?.type}`);
    expect(settled.status).toBe("completed");

    await session.close();
    await instance.dispose();
  }, 240_000);
});
