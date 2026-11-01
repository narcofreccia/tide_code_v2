import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { claudeDriver } from "../src/index.ts";

/**
 * Real end-to-end turn against the installed, logged-in `claude`. Off by default because it
 * spends tokens and needs a login:  TIDE_LIVE=1 pnpm --filter @tide/driver-claude test
 */
const live = process.env["TIDE_LIVE"] === "1" ? describe : describe.skip;

live("claude driver (live)", () => {
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (msg) => logs.push(msg) };

  it("reports an installed, logged-in provider with harness-supplied models", async () => {
    const instance = await claudeDriver.create(claudeDriver.defaultConfig(), env);
    const status = await instance.status();
    expect(status.kind).toBe("claude");
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(status.models.length).toBeGreaterThan(1);
    expect(status.models.every((model) => !model.label.includes("fallback"))).toBe(true);
    expect(status.caps.planMode).toBe(true);
    // second call is served from the 60s cache
    expect(await instance.status()).toBe(status);
    expect(instance.terminalCommand("abc-123", "/tmp/my repo")).toBe("cd '/tmp/my repo' && claude --resume abc-123");
    await instance.dispose();
  }, 120_000);

  it("runs one real turn and settles", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tide-claude-live-"));
    writeFileSync(join(cwd, "hello.txt"), "hello from tide\n");
    const instance = await claudeDriver.create(claudeDriver.defaultConfig(), env);
    const session = await instance.openSession({
      threadId: "live",
      cwd,
      mode: "auto-accept-edits",
      interaction: "default",
      mcpServers: [],
    });

    const events: NormalizedEvent[] = [];
    for await (const event of session.send({ text: "List the files here in one line. Do not use any tools other than Bash." })) events.push(event);

    const session0 = events[0];
    expect(session0?.type).toBe("session");
    if (session0?.type !== "session") throw new Error("unreachable");
    expect(session0.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.nativeSessionId).toBe(session0.nativeSessionId);

    const settled = events.at(-1);
    if (settled?.type !== "settled") throw new Error(`last event was ${settled?.type}`);
    expect(settled.status).toBe("completed");

    expect(events.some((event) => event.type === "assistant.delta")).toBe(true);
    expect(events.some((event) => event.type === "usage" && event.usage !== undefined)).toBe(true);
    expect(events.some((event) => event.type === "usage" && event.contextUsage !== undefined)).toBe(true);

    await session.close();
    await instance.dispose();
  }, 180_000);

  it("takes a steer into a turn Claude Code runs on its own after a background sub-agent reports", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tide-claude-live-harness-"));
    const instance = await claudeDriver.create(claudeDriver.defaultConfig(), env);
    const session = await instance.openSession({ threadId: "live-harness", cwd, mode: "full-access", interaction: "default", mcpServers: [] });
    const harnessTurn = new Promise<{ reason: string; events: AsyncIterable<NormalizedEvent> }>((resolve) => session.onHarnessTurn?.(resolve));

    const first: NormalizedEvent[] = [];
    const prompt =
      "Launch exactly one background sub-agent with the Agent tool (run_in_background: true) whose only job is to run `sleep 15 && echo ready` with Bash and report the output. " +
      "Do not wait for it: reply with the single word launched and end your turn. When it reports later, summarize its report in one sentence.";
    for await (const event of session.send({ text: prompt })) first.push(event);
    expect(first.at(-1)).toMatchObject({ type: "settled", status: "completed" });

    const turn = await harnessTurn;
    // the CLI is already running the harness turn: the steer joins it instead of being refused
    await session.steer!({ text: "Also end that summary with the exact word PINEAPPLE." });
    const events: NormalizedEvent[] = [];
    for await (const event of turn.events) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: "settled", status: "completed" });
    const said = events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : [])).join("");
    expect(said).toContain("PINEAPPLE");

    await session.close();
    await instance.dispose();
  }, 300_000);
});
