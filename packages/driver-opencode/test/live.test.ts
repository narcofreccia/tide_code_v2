import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, RuntimeMode } from "@tide/contracts";
import { eventSessionId } from "../src/hub.ts";
import { opencodeDriver } from "../src/index.ts";
import type { OpencodeConfig } from "../src/types.ts";
import type { OpencodeEvent } from "../src/wire.ts";

/**
 * Real end-to-end turns against an OpenCode 2 binary. Off by default:
 *   TIDE_LIVE=1 [TIDE_OPENCODE_BIN=/path/to/opencode-2] [OPENCODE_MODEL=opencode/big-pickle] \
 *     pnpm --filter @tide/driver-opencode test
 * Attaches to the shared service when one is registered under $XDG_STATE_HOME, else spawns
 * a private server. The default model is a free Zen model that needs no login.
 * (`OPENCODE_BIN` is still read when `TIDE_OPENCODE_BIN` is unset.)
 */
const live = process.env["TIDE_LIVE"] === "1" ? describe : describe.skip;
const binary = process.env["TIDE_OPENCODE_BIN"] ?? process.env["OPENCODE_BIN"];
const config: OpencodeConfig = {
  ...(binary ? { binaryPath: binary } : {}),
  defaultModel: process.env["OPENCODE_MODEL"] ?? "opencode/big-pickle",
};
const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/**
 * Writes the raw events of one turn — the session's and every sub-agent session it spawned
 * (followed through `session.created.parentID`) — with the home directory scrubbed.
 */
function writeFixture(name: string, raw: OpencodeEvent[], sessionId: string): void {
  const sessions = new Set([sessionId]);
  const lines: string[] = [];
  for (const event of raw) {
    const id = eventSessionId(event);
    const parent = (event as { data?: { parentID?: unknown } }).data?.parentID;
    if (id !== undefined && event.type === "session.created" && typeof parent === "string" && sessions.has(parent)) sessions.add(id);
    if (id === undefined || !sessions.has(id)) continue;
    lines.push(JSON.stringify(event).split(homedir()).join("/Users/tester"));
  }
  writeFileSync(join(fixtureDir, `${name}.ndjson`), `${lines.join("\n")}\n`);
}

/** One sub-agent turn on a private server; every approval is accepted. */
async function subagentTurn(name: string, mode: RuntimeMode, command: string): Promise<NormalizedEvent[]> {
  const raw: OpencodeEvent[] = [];
  const cwd = mkdtempSync(join(tmpdir(), `tide-opencode-${name}-`));
  const instance = await opencodeDriver.create({ ...config, attach: "standalone", eventTap: (event) => raw.push(event) }, { dataDir: tmpdir(), log: () => undefined });
  const session = await instance.openSession({ threadId: name, cwd, mode, interaction: "default", mcpServers: [] });
  const events: NormalizedEvent[] = [];
  try {
    const prompt = `Use the subagent tool with agent "general" and ask it to run the shell command \`${command}\` and report the output. Do not run it yourself. Then reply with the subagent's answer.`;
    for await (const event of session.send({ text: prompt })) {
      events.push(event);
      if (event.type === "activity" && event.activity.kind === "approval") await session.respondApproval(event.activity.requestId, "accept");
    }
  } finally {
    writeFixture(name, raw, session.nativeSessionId ?? "");
    await session.close();
    await instance.dispose();
  }
  return events;
}

const activities = (events: NormalizedEvent[]) => events.flatMap((event) => (event.type === "activity" ? [event.activity] : []));

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

  it("follows a sub-agent's child session: its tool rows nest under the child row", async () => {
    const events = await subagentTurn("subagent-turn", "auto", "echo sub-ok");
    const child = activities(events).find((activity) => activity.kind === "child");
    if (child?.kind !== "child") throw new Error("no child row");
    const nested = activities(events).filter((activity) => activity.kind === "tool" && activity.parentToolUseId === child.childKey);
    expect(nested.length).toBeGreaterThan(0);
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  }, 300_000);

  it("surfaces a sub-agent's permission ask and answers it in the child session", async () => {
    const events = await subagentTurn("subagent-permission", "approval-required", "echo sub-perm-ok");
    const child = activities(events).find((activity) => activity.kind === "child");
    if (child?.kind !== "child") throw new Error("no child row");
    const approval = activities(events).find((activity) => activity.kind === "approval" && activity.parentToolUseId === child.childKey);
    expect(approval).toBeDefined();
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  }, 300_000);
});
