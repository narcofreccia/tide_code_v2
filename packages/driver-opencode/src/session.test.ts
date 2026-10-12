import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { FakeOpencodeApi } from "../test/fake-api.ts";
import { EventHub } from "./hub.ts";
import { OpencodeSession, type SessionDeps } from "./session.ts";

function harness(options: Partial<OpenSessionOptions> = {}, deps: Partial<SessionDeps> = {}): { session: OpencodeSession; api: FakeOpencodeApi; logs: string[]; hub: EventHub } {
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (msg) => logs.push(msg) };
  const api = new FakeOpencodeApi();
  const hub = new EventHub(async () => api, (msg) => logs.push(msg));
  const full: OpenSessionOptions = { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [], ...options };
  const session = new OpencodeSession(env, full, { api, hub, agents: { build: "build", plan: "plan" }, ...deps }, api.sessionId);
  return { session, api, logs, hub };
}

async function collect(stream: AsyncIterable<NormalizedEvent>, sink: NormalizedEvent[]): Promise<void> {
  for await (const event of stream) sink.push(event);
}

/** flushes pending promise chains (pump → hub → mailbox → consumer); everything here is in-memory */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("OpencodeSession", () => {
  it("subscribes before prompting, sends text and images as data: URIs", async () => {
    const { session, api } = harness({}, { model: { providerID: "opencode", id: "big-pickle" } });
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "hi", images: [{ mediaType: "image/png", data: "AAAA" }] }), events);
    await settle();
    expect(api.subscribes).toBe(1);
    expect(api.prompts[0]).toEqual({ sessionId: "ses_fake", text: "hi", files: [{ uri: "data:image/png;base64,AAAA", name: "image-1" }] });
    expect(events[0]).toEqual({ type: "session", nativeSessionId: "ses_fake", model: "opencode/big-pickle" });
    api.succeeded();
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("reuses one hub subscription across turns and carries the usage baseline forward", async () => {
    const { session, api } = harness({}, { baseline: { cost: 0, tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } } });
    for (const total of [150, 230]) {
      const events: NormalizedEvent[] = [];
      const done = collect(session.send({ text: "go" }), events);
      await settle();
      api.usage({ input: total, output: 10, reasoning: 0, cache: { read: 0, write: 0 } });
      api.succeeded();
      await done;
      const usage = events.find((event) => event.type === "usage");
      expect(usage?.type === "usage" ? usage.usage?.inputTokens : undefined).toBe(total === 150 ? 50 : 80);
    }
    expect(api.subscribes).toBe(1);
  });

  it("round-trips an approval and refuses a concurrent turn", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await settle();
    expect(() => session.send({ text: "again" })).toThrow(/busy/);
    api.toolStart("call_1", "shell", { command: "ls" });
    api.permissionAsked("per_1", "shell", ["ls"], { save: ["ls *"], source: { type: "tool", messageID: "msg_1", id: "call_1" } });
    await settle();
    const approval = events.find((event) => event.type === "activity" && event.activity.kind === "approval");
    expect(approval).toMatchObject({ activity: { requestId: "per_1", toolName: "shell", input: { command: "ls" } } });
    await session.respondApproval("per_1", "accept");
    expect(api.permissionReplies).toEqual([{ requestId: "per_1", decision: "once" }]);
    api.succeeded();
    await done;
  });

  it("accept-for-session answers `once` and auto-accepts later matching asks without a card", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await settle();
    api.permissionAsked("per_1", "shell", ["echo a"], { save: ["echo *"] });
    await settle();
    await session.respondApproval("per_1", "acceptForSession");
    api.permissionAsked("per_2", "shell", ["echo b"], { save: ["echo *"] });
    api.permissionAsked("per_3", "shell", ["rm b"], { save: ["rm *"] });
    await settle();
    expect(api.permissionReplies).toEqual([
      { requestId: "per_1", decision: "once" },
      { requestId: "per_2", decision: "once" },
    ]);
    const cards = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "approval" ? [event.activity.requestId] : []));
    expect(cards).toEqual(["per_1", "per_3"]);
    api.succeeded();
    await done;
  });

  it("answers a question form with option values keyed by field", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await settle();
    api.formCreated("frm_1", [
      { key: "q0", type: "string", description: "Tabs or spaces?", options: [{ value: "tabs-v", label: "Tabs" }, { value: "spaces-v", label: "Spaces" }], custom: true },
      { key: "q1", type: "multiselect", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] },
    ]);
    await settle();
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "user-input")).toBe(true);
    await session.respondUserInput("frm_1", { q0: "Spaces", q1: ["A", "B"] });
    expect(api.formReplies).toEqual([{ formId: "frm_1", answer: { q0: "spaces-v", q1: ["a", "b"] } }]);
    api.succeeded();
    await done;
  });

  it("settles with an error when the server's event stream dies mid-turn, and resubscribes next turn", async () => {
    const { session, api, logs } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await settle();
    api.failStream();
    await done;
    expect(events.at(-1)).toMatchObject({ type: "settled", status: "error" });
    expect(logs.some((line) => line.includes("resubscribes"))).toBe(true);

    const next: NormalizedEvent[] = [];
    const again = collect(session.send({ text: "again" }), next);
    await settle();
    expect(api.subscribes).toBe(2);
    api.succeeded();
    await again;
    expect(next.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("settles with the error when the prompt is refused", async () => {
    const { session, api } = harness();
    api.promptError = new Error("HTTP 400");
    const events: NormalizedEvent[] = [];
    await collect(session.send({ text: "go" }), events);
    expect(events.at(-1)).toEqual({ type: "settled", status: "error", error: "HTTP 400" });
  });

  it("interrupts through the API and settles as interrupted", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await settle();
    await session.interrupt();
    expect(api.interrupts).toBe(1);
    api.emit("session.execution.interrupted", { reason: "user" });
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
  });

  it("reconfigures model, agent and ruleset in place", async () => {
    const { session, api } = harness({}, { resolveModel: async (id) => ({ model: { providerID: "opencode", id: id!.split("/")[1]! }, contextWindow: 10 }) });
    expect(await session.reconfigure({ model: "opencode/small", mode: "auto", interaction: "plan" })).toBe("applied");
    expect(api.modelSwitches).toEqual([{ providerID: "opencode", id: "small" }]);
    expect(api.agentSwitches).toEqual(["plan"]);
    // plan mode keeps no allow rules even though the mode is `auto`
    expect(api.rulesets[0]?.permissions.some((rule) => rule.effect === "allow")).toBe(false);
    expect(session.agent).toBe("plan");
  });

  it("answers `reopen` when the server refuses an in-place change", async () => {
    const { session, api } = harness();
    api.switchError = new Error("HTTP 404");
    expect(await session.reconfigure({ mode: "auto", interaction: "plan" })).toBe("reopen");
  });

  it("removes its thread-scoped MCP registrations on close", async () => {
    const { session, api } = harness({}, { mcpNames: ["tide-t1"] });
    await session.close();
    await session.close();
    expect(api.mcpRemoved).toEqual([{ directory: "/repo", name: "tide-t1" }]);
    expect(() => session.send({ text: "x" })).toThrow(/closed/);
  });
});
