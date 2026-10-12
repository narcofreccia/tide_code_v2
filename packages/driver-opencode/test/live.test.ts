import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { opencodeDriver } from "../src/index.ts";
import type { OpencodeConfig } from "../src/types.ts";

/**
 * Real end-to-end turns against an OpenCode 2 binary. Off by default:
 *   TIDE_LIVE=1 [OPENCODE_BIN=/path/to/opencode-2] [OPENCODE_MODEL=opencode/big-pickle] \
 *     pnpm --filter @tide/driver-opencode test
 * Attaches to the shared service when one is registered under $XDG_STATE_HOME, else spawns
 * a private server. The default model is a free Zen model that needs no login.
 */
const live = process.env["TIDE_LIVE"] === "1" ? describe : describe.skip;
const config: OpencodeConfig = {
  ...(process.env["OPENCODE_BIN"] ? { binaryPath: process.env["OPENCODE_BIN"] } : {}),
  defaultModel: process.env["OPENCODE_MODEL"] ?? "opencode/big-pickle",
};

live("opencode 2 driver (live)", () => {
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (msg) => logs.push(msg) };

  it("reports an installed 2.x provider with harness-supplied models", async () => {
    const instance = await opencodeDriver.create(config, env);
    const status = await instance.status();
    expect(status).toMatchObject({ kind: "opencode", installed: true, loggedIn: true });
    expect(status.version).toMatch(/^2\.\d+\.\d+$/);
    expect(status.models.length).toBeGreaterThan(0);
    expect(status.models.every((model) => model.id.includes("/"))).toBe(true);
    expect(status.caps.planMode).toBe(true);
    await instance.dispose();
  }, 120_000);

  it("runs a turn with a shell approval round-trip, then reconfigures in place", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tide-opencode-live-"));
    writeFileSync(join(cwd, "hello.txt"), "hello from tide\n");
    const instance = await opencodeDriver.create(config, env);
    const session = await instance.openSession({
      threadId: "live",
      cwd,
      mode: "approval-required",
      interaction: "default",
      mcpServers: [],
      systemPromptAppend: "Project tag for this conversation: PELICAN-42.",
    });

    const events: NormalizedEvent[] = [];
    for await (const event of session.send({ text: "Run the shell command `echo live-ok` and then reply with its output and the project tag from your instructions." })) {
      events.push(event);
      if (event.type === "activity" && event.activity.kind === "approval") await session.respondApproval(event.activity.requestId, "accept");
    }
    const opened = events[0];
    if (opened?.type !== "session") throw new Error("first event was not `session`");
    expect(opened.nativeSessionId).toMatch(/^ses/);
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "approval")).toBe(true);
    const text = events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : [])).join("");
    expect(text).toContain("live-ok");
    expect(text).toContain("PELICAN-42");
    expect(events.some((event) => event.type === "usage" && (event.usage?.inputTokens ?? 0) > 0)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });

    if (!session.reconfigure) throw new Error("reconfigure missing");
    expect(await session.reconfigure({ mode: "auto", interaction: "plan" })).toBe("applied");
    await session.close();
    await instance.dispose();
  }, 300_000);
});
