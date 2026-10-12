import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, ProviderInstance, ProviderSession } from "@tide/contracts";
import { createPiInstance, PI_QUESTION_ID, workspaceBinary } from "../src/index.ts";
import { mockAgentDir, startMockModel, type MockModel } from "./mock-model.ts";

/**
 * The whole driver against a REAL `pi --mode rpc` 1.1.0 + the real tide-bridge, with only the
 * model scripted (mock-model.ts). Needs no credentials and no network beyond loopback, so it
 * runs by default; it checks what fake-pi cannot: that pi actually connects Tide's MCP server
 * and declares its tools, forwards extension dialogs, takes `/tide-config` and `set_model`
 * live, and reports `aborted`.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pi");
const logs: string[] = [];
const env: DriverEnv = { dataDir: tmpdir(), log: (message) => logs.push(message) };
const toolNames = (request: Record<string, unknown> | undefined): string[] =>
  ((request?.["tools"] as { function?: { name?: string } }[] | undefined) ?? []).map((tool) => tool.function?.name ?? "");

/** Drains one turn, answering approvals and questions as they come. */
async function turn(session: ProviderSession, text: string, answer: (event: NormalizedEvent) => Promise<void> | void = () => undefined): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  for await (const event of session.send({ text })) {
    events.push(event);
    await answer(event);
  }
  return events;
}

const real = workspaceBinary() ? describe : describe.skip;

real("driver over a real pi 1.1.0 (scripted model)", () => {
  let model: MockModel;
  let instance: ProviderInstance;
  let session: ProviderSession;

  beforeAll(async () => {
    model = await startMockModel();
    const agentDir = mockAgentDir(model.baseUrl);
    instance = createPiInstance(
      { defaultModel: "mock/mock-1", env: { PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, extraExtensions: [join(fixtures, "ask-extension.ts")] },
      env,
    );
    session = await instance.openSession({
      threadId: "real",
      cwd: mkdtempSync(join(tmpdir(), "tide-pi-real-")),
      mode: "approval-required",
      interaction: "default",
      mcpServers: [{ name: "echo", command: process.execPath, args: [join(fixtures, "echo-mcp.mjs")] }],
    });
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    await instance?.dispose();
    await model?.close();
  });

  it("attaches Tide's MCP server natively: its tool is declared to the model and runs as server/tool", async () => {
    model.push({ toolCalls: [{ name: "mcp__echo__echo", arguments: { text: "ping" } }] }, { text: "Echoed." });
    const events = await turn(session, "echo ping");
    expect(toolNames(model.requests.at(-2))).toContain("mcp__echo__echo");
    const tool = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : [])).at(-1);
    // readOnlyHint on the MCP tool → no approval card even in approval-required
    expect(tool).toMatchObject({ toolName: "echo/echo", status: "ok", output: "echo: ping" });
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "approval")).toBe(false);
    // get_session_stats totals → per-turn delta: the mock bills 100·n input / 10·n output tokens
    // for its n-th request, and this turn made requests 1 and 2
    const usage = events.flatMap((event) => (event.type === "usage" && event.usage ? [event.usage] : []));
    expect(usage).toEqual([{ inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 }]);
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  }, 60_000);

  it("asks the user through an extension's select/input dialogs and returns the answers", async () => {
    model.push({ toolCalls: [{ name: "ask_user", arguments: {} }] }, { text: "Thanks." });
    const events = await turn(session, "ask me", async (event) => {
      if (event.type !== "activity") return;
      // ask_user is a tool Tide does not model → approval first (approval-required)
      if (event.activity.kind === "approval") await session.respondApproval(event.activity.requestId, "accept");
      if (event.activity.kind === "user-input") {
        const question = event.activity.questions[0];
        await session.respondUserInput(event.activity.requestId, { [PI_QUESTION_ID]: question?.options ? "blue" : "Ada" });
      }
    });
    const questions = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "user-input" ? [event.activity.questions[0]?.text] : []));
    expect(questions).toEqual(["Pick a colour", "Your name\n(e.g. Ada)"]);
    const tool = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : [])).at(-1);
    expect(tool).toMatchObject({ toolName: "ask_user", status: "ok", output: "colour=blue name=Ada" });
    // the second turn's usage is its own delta (requests 3 and 4), not the session total
    expect(events.flatMap((event) => (event.type === "usage" && event.usage ? [event.usage.inputTokens] : []))).toEqual([700]);
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  }, 60_000);

  it("switches to plan mode live (no restart): writes are refused and the plan tool appears", async () => {
    expect(await session.reconfigure?.({ mode: "auto", interaction: "plan", model: "mock/mock-1" })).toBe("applied");
    model.push(
      { toolCalls: [{ name: "bash", arguments: { command: "sed -i s/a/b/ file.txt" } }] },
      { toolCalls: [{ name: "tide_propose_plan", arguments: { plan: "# Plan\n\n1. Edit file.txt" } }] },
      { text: "Proposed." },
    );
    const events = await turn(session, "plan it");
    expect(toolNames(model.requests.at(-3))).toContain("tide_propose_plan");
    const blocked = events.find((event) => event.type === "activity" && event.activity.kind === "tool" && event.activity.status === "error");
    expect(blocked).toMatchObject({ activity: { toolName: "bash", output: expect.stringContaining("Plan mode") } });
    expect(events.find((event) => event.type === "plan.proposed")).toEqual({ type: "plan.proposed", markdown: "# Plan\n\n1. Edit file.txt" });

    // and back: the plan tool is withdrawn from the next request
    expect(await session.reconfigure?.({ mode: "auto", interaction: "default", model: "mock/mock-1" })).toBe("applied");
    model.push({ text: "ok" });
    await turn(session, "carry on");
    expect(toolNames(model.requests.at(-1))).not.toContain("tide_propose_plan");
  }, 60_000);

  it("switches the model with set_model and reports a real interruption as interrupted", async () => {
    expect(await session.reconfigure?.({ mode: "auto", interaction: "default", model: "mock/mock-2" })).toBe("applied");
    model.push({ toolCalls: [{ name: "bash", arguments: { command: "sleep 30" } }] });
    const events = await turn(session, "wait", async (event) => {
      if (event.type === "activity" && event.activity.kind === "tool" && event.activity.status === "running") await session.interrupt();
    });
    expect(model.requests.at(-1)?.["model"]).toBe("mock-2");
    expect(events.at(-1)).toMatchObject({ type: "settled", status: "interrupted" });
    expect(logs.some((line) => line.includes("extension_error"))).toBe(false);
  }, 60_000);
});
