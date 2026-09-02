import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { FakeOpencodeApi } from "../test/fake-api.ts";
import { OpencodeSession, type SessionDeps } from "./session.ts";

function harness(options: Partial<OpenSessionOptions> = {}, deps: Partial<SessionDeps> = {}): { session: OpencodeSession; api: FakeOpencodeApi; logs: string[] } {
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (msg) => logs.push(msg) };
  const api = new FakeOpencodeApi();
  const full: OpenSessionOptions = { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [], ...options };
  const session = new OpencodeSession(env, full, { api, agent: "build", ...deps }, api.sessionId);
  return { session, api, logs };
}

async function collect(stream: AsyncIterable<NormalizedEvent>, sink: NormalizedEvent[]): Promise<void> {
  for await (const event of stream) sink.push(event);
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("OpencodeSession", () => {
  it("subscribes before prompting and passes agent, model, system prompt and images through", async () => {
    const { session, api } = harness({ systemPromptAppend: "be terse" }, { model: { providerID: "opencode", modelID: "big-pickle" } });
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "hi", images: [{ mediaType: "image/png", data: "AAAA" }] }), events);
    await tick();

    expect(api.subscribes).toBe(1);
    const prompt = api.prompts[0];
    expect(prompt?.agent).toBe("build");
    expect(prompt?.model).toEqual({ providerID: "opencode", modelID: "big-pickle" });
    expect(prompt?.system).toBe("be terse");
    expect(prompt?.parts[0]).toEqual({ type: "file", mime: "image/png", filename: "image-1", url: "data:image/png;base64,AAAA" });
    expect(prompt?.parts[1]).toEqual({ type: "text", text: "hi" });
    expect(events[0]).toEqual({ type: "session", nativeSessionId: "ses_fake", model: "opencode/big-pickle" });

    api.idle();
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("streams text, tool rows and usage, then settles once", async () => {
    const { session, api } = harness({}, { contextWindow: 1000 });
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await tick();

    api.text("prt_1", "msg_1", "hel", "hel");
    api.text("prt_1", "msg_1", "hello", "lo");
    api.tool("prt_2", "call_1", "bash", { status: "running", input: { command: "ls" }, time: { start: 1 } });
    api.tool("prt_2", "call_1", "bash", { status: "completed", input: { command: "ls" }, output: "a\nb", time: { start: 1, end: 4 } });
    api.assistantDone("msg_1");
    api.idle();
    await done;

    const deltas = events.filter((event) => event.type === "assistant.delta");
    expect(deltas.map((delta) => delta.delta).join("")).toBe("hello");
    expect(new Set(deltas.map((delta) => delta.messageKey))).toEqual(new Set(["prt_1"]));

    const tools = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));
    expect(tools).toHaveLength(2);
    expect(tools[0]).toMatchObject({ toolUseId: "prt_2", toolName: "bash", status: "running" });
    expect(tools[1]).toMatchObject({ status: "ok", output: "a\nb", durationMs: 3 });

    const usage = events.find((event) => event.type === "usage");
    if (usage?.type !== "usage") throw new Error("no usage event");
    expect(usage.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 1, costUsd: 0.02 });
    expect(usage.contextUsage).toEqual({ used: 19, window: 1000 });
    expect(events.filter((event) => event.type === "settled")).toHaveLength(1);
  });

  it("round-trips an approval: pending activity out, decision in", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await tick();

    api.tool("prt_2", "call_1", "bash", { status: "running", input: { command: "rm -rf /" } });
    api.permissionAsked("per_1", "bash", { tool: { messageID: "msg_1", callID: "call_1" }, patterns: ["rm -rf /"] });
    await tick();

    const approval = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "approval" ? [event.activity] : []))[0];
    expect(approval).toMatchObject({ requestId: "per_1", toolName: "bash", status: "pending", input: { command: "rm -rf /" } });

    await session.respondApproval("per_1", "acceptForSession");
    expect(api.permissions).toEqual([{ permissionId: "per_1", reply: "always" }]);
    await session.respondApproval("per_1", "decline");
    expect(api.permissions[1]).toEqual({ permissionId: "per_1", reply: "reject" });

    api.idle();
    await done;
  });

  it("answers questions by option label, in the order the harness asked them", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await tick();

    api.questionAsked("que_1", [
      { question: "Which framework?", options: [{ label: "Vite" }, { label: "Next" }] },
      { question: "Which tests?", options: [{ label: "vitest", description: "fast" }], multiple: true },
    ]);
    await tick();

    const input = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "user-input" ? [event.activity] : []))[0];
    expect(input?.requestId).toBe("que_1");
    expect(input?.questions[0]).toEqual({ id: "q0", text: "Which framework?", options: [{ label: "Vite" }, { label: "Next" }] });
    expect(input?.questions[1]).toMatchObject({ id: "q1", multi: true, options: [{ label: "vitest", description: "fast" }] });

    await session.respondUserInput("que_1", { q0: "Vite", q1: ["vitest"] });
    expect(api.answers).toEqual([{ requestId: "que_1", answers: [["Vite"], ["vitest"]] }]);

    api.idle();
    await done;
  });

  it("auto-rejects plan_exit and records the plan instead of implementing it", async () => {
    const { session, api } = harness({ interaction: "plan" }, { agent: "plan" });
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "plan it" }), events);
    await tick();

    api.text("prt_1", "msg_1", "# Plan\n1. do it", "# Plan\n1. do it");
    api.permissionAsked("per_plan", "plan_exit", { metadata: { plan: "# Plan\n1. do it" } });
    await tick();
    expect(api.permissions).toEqual([{ permissionId: "per_plan", reply: "reject" }]);

    api.assistantDone("msg_1", { agent: "plan" });
    api.idle();
    await done;

    const plans = events.filter((event) => event.type === "plan.proposed");
    expect(plans).toHaveLength(2); // once from plan_exit, once when the plan message completed
    expect(plans[0]).toEqual({ type: "plan.proposed", markdown: "# Plan\n1. do it" });
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "approval")).toBe(false);
  });

  it("interrupt aborts the native session and settles as interrupted", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await tick();

    await session.interrupt();
    expect(api.aborts).toBe(1);
    api.idle();
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
  });


  it("resubscribes on the next turn after the event stream errors", async () => {
    const { session, api } = harness();
    const first: NormalizedEvent[] = [];
    const firstDone = collect(session.send({ text: "one" }), first);
    await tick();
    expect(api.subscribes).toBe(1);

    api.failStream(new Error("connection reset"));
    await firstDone;
    expect(first.at(-1)).toEqual({ type: "settled", status: "error", error: "opencode event stream ended before the turn settled" });

    // without clearing the dead handle the second turn would prompt into a stream nobody reads
    const second: NormalizedEvent[] = [];
    const secondDone = collect(session.send({ text: "two" }), second);
    await tick();
    expect(api.subscribes).toBe(2);
    expect(api.prompts).toHaveLength(2);
    api.idle();
    await secondDone;
    expect(second.at(-1)).toEqual({ type: "settled", status: "completed" });
    await session.close();
  });

  it("disconnects only its own MCP registrations on close", async () => {
    const { session, api } = harness({}, { mcpNames: ["tide-t1"] });
    await session.close();
    expect(api.mcpDisconnected).toEqual([{ directory: "/repo", name: "tide-t1" }]);
  });

  it("refuses a second concurrent turn and reports prompt failures as an error settle", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "one" }), events);
    await tick();
    expect(() => session.send({ text: "two" })).toThrow(/busy/);
    api.idle();
    await done;

    api.promptError = new Error("model not found");
    const second: NormalizedEvent[] = [];
    await collect(session.send({ text: "three" }), second);
    expect(second.at(-1)).toEqual({ type: "settled", status: "error", error: "model not found" });
    await session.close();
  });
});
