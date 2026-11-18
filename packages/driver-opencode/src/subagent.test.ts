import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent } from "@tide/contracts";
import { FakeOpencodeApi } from "../test/fake-api.ts";
import { EventHub } from "./hub.ts";
import { OpencodeSession } from "./session.ts";

/**
 * Sub-agents run in child sessions (`subagent` tool → `session.created {parentID}` →
 * `session.tool.progress {metadata.sessionID}`), shapes as recorded from opencode 2.0.29
 * (test/fixtures/subagent-*.ndjson).
 */
const CHILD = "ses_child";
const TOKENS = (input: number, output = 0) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } });

function harness(): { session: OpencodeSession; api: FakeOpencodeApi; hub: EventHub } {
  const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
  const api = new FakeOpencodeApi();
  const hub = new EventHub(async () => api, () => undefined);
  const session = new OpencodeSession(env, { threadId: "t1", cwd: "/repo", mode: "approval-required", interaction: "default", mcpServers: [] }, { api, hub, agents: { build: "build", plan: "plan" } }, api.sessionId);
  return { session, api, hub };
}

async function collect(stream: AsyncIterable<NormalizedEvent>, sink: NormalizedEvent[]): Promise<void> {
  for await (const event of stream) sink.push(event);
}

/** flushes pending promise chains (pump → hub → mailbox → consumer); everything here is in-memory */
const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** The parent calls `subagent`; core creates the child and reports it as tool progress. */
function launchChild(api: FakeOpencodeApi, created = true, child = CHILD): void {
  api.toolStart("call_sub", "subagent", { agent: "general", description: "Run echo", prompt: "run echo" });
  if (created) api.emitIn(child, "session.created", { parentID: api.sessionId, agent: "general" });
  api.emit("session.tool.progress", { assistantMessageID: "msg_1", id: "call_sub", metadata: { sessionID: child, status: "running" } });
}

const activities = (events: NormalizedEvent[]) => events.flatMap((event) => (event.type === "activity" ? [event.activity] : []));

describe("OpenCode sub-agent sessions", () => {
  it("nests the child's tools and approval under the child row and replies in the child session", async () => {
    const { session, api, hub } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await settle();
    launchChild(api);
    api.emitIn(CHILD, "session.text.delta", { assistantMessageID: "msg_c", ordinal: 0, delta: "child chatter" });
    api.emitIn(CHILD, "session.tool.input.started", { assistantMessageID: "msg_c", id: "call_sh", name: "shell" });
    api.emitIn(CHILD, "session.tool.called", { assistantMessageID: "msg_c", id: "call_sh", input: { command: "echo hi" }, executed: false });
    api.emitIn(CHILD, "permission.asked", { id: "per_c", action: "shell", resources: ["echo hi"], source: { type: "tool", messageID: "msg_c", id: "call_sh" } });
    await settle();
    expect(hub.followed).toBe(1);
    const approval = activities(events).find((activity) => activity.kind === "approval");
    expect(approval).toMatchObject({ requestId: "per_c", toolName: "shell", input: { command: "echo hi" }, parentToolUseId: "call_sub" });
    await session.respondApproval("per_c", "accept");
    expect(api.permissionReplies).toEqual([{ requestId: "per_c", decision: "once" }]);
    expect(api.permissionReplySessions).toEqual([CHILD]);

    api.emitIn(CHILD, "session.tool.success", { assistantMessageID: "msg_c", id: "call_sh", content: [{ type: "text", text: "hi" }], executed: false });
    // the child finishing must not end the Tide turn
    api.emitIn(CHILD, "session.execution.succeeded", {});
    await settle();
    expect(events.some((event) => event.type === "settled")).toBe(false);

    api.toolSuccess("call_sub", `<subagent sessionID="${CHILD}" state="completed">\nhi\n</subagent>`);
    api.succeeded();
    await done;

    const rows = activities(events);
    expect(rows.filter((activity) => activity.kind === "tool" && activity.toolUseId === "call_sh").every((activity) => activity.parentToolUseId === "call_sub")).toBe(true);
    expect(rows.find((activity) => activity.kind === "child" && activity.status === "done")).toMatchObject({ childKey: "call_sub", report: "hi", summary: "hi" });
    expect(events.some((event) => event.type === "assistant.delta")).toBe(false);
    expect(events.filter((event) => event.type === "settled")).toEqual([{ type: "settled", status: "completed" }]);
    // nothing is followed once the turn is over
    expect(hub.followed).toBe(0);
  });

  it("stops delivering a child's events after the turn, and a later turn starts clean", async () => {
    const { session, api, hub } = harness();
    const first: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), first);
    await settle();
    launchChild(api);
    api.toolSuccess("call_sub", "ok");
    api.succeeded();
    await done;
    expect(hub.followed).toBe(0);

    const second: NormalizedEvent[] = [];
    const next = collect(session.send({ text: "again" }), second);
    await settle();
    // a background child still running from the first turn: not this turn's
    api.emitIn(CHILD, "permission.asked", { id: "per_late", action: "shell", resources: ["ls"] });
    api.succeeded();
    await next;
    expect(activities(second).some((activity) => activity.kind === "approval")).toBe(false);
  });

  it("answers a child's form in the child session", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await settle();
    launchChild(api);
    api.emitIn(CHILD, "form.created", {
      form: { id: "frm_c", sessionID: CHILD, title: "Q", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string", description: "Tabs?", options: [{ value: "t", label: "tabs" }] }] },
    });
    await settle();
    expect(activities(events).find((activity) => activity.kind === "user-input")).toMatchObject({ requestId: "frm_c", parentToolUseId: "call_sub" });
    await session.respondUserInput("frm_c", { q0: "tabs" });
    expect(api.formReplies).toEqual([{ formId: "frm_c", answer: { q0: "t" } }]);
    expect(api.formReplySessions).toEqual([CHILD]);
    api.succeeded();
    await done;
  });

  it("follows a grandchild to the same turn and nests it under its own launcher", async () => {
    const { session, api, hub } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await settle();
    launchChild(api);
    api.emitIn(CHILD, "session.tool.input.started", { assistantMessageID: "msg_c", id: "call_sub2", name: "subagent" });
    api.emitIn(CHILD, "session.tool.called", { assistantMessageID: "msg_c", id: "call_sub2", input: { agent: "explore", description: "Look", prompt: "look" }, executed: false });
    api.emitIn("ses_grand", "session.created", { parentID: CHILD, agent: "explore" });
    api.emitIn(CHILD, "session.tool.progress", { assistantMessageID: "msg_c", id: "call_sub2", metadata: { sessionID: "ses_grand", status: "running" } });
    api.emitIn("ses_grand", "session.tool.input.started", { assistantMessageID: "msg_g", id: "call_read", name: "read" });
    api.emitIn("ses_grand", "session.tool.called", { assistantMessageID: "msg_g", id: "call_read", input: { path: "a" }, executed: false });
    await settle();
    expect(hub.followed).toBe(2);
    const rows = activities(events);
    expect(rows.find((activity) => activity.kind === "child" && activity.childKey === "call_sub2")).toMatchObject({ parentToolUseId: "call_sub" });
    expect(rows.find((activity) => activity.kind === "tool" && activity.toolUseId === "call_read")).toMatchObject({ parentToolUseId: "call_sub2" });
    api.succeeded();
    await done;
    expect(hub.followed).toBe(0);
  });

  it("adds the child's step usage to the turn (OpenCode keeps it on the child session)", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await settle();
    launchChild(api);
    api.emitIn(CHILD, "session.step.ended", { assistantMessageID: "msg_c", finish: "stop", cost: 0.25, tokens: TOKENS(300, 30) });
    api.emitIn(CHILD, "session.usage.updated", { cost: 0.25, tokens: TOKENS(300, 30) });
    api.usage(TOKENS(100, 10), 0.5);
    api.succeeded();
    await done;
    const usage = events.find((event) => event.type === "usage");
    expect(usage?.type === "usage" ? usage.usage : undefined).toEqual({ inputTokens: 400, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.75 });
  });

  it("re-applies the thread's ruleset to a resumed child and interrupts children with the turn", async () => {
    const { session, api } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await settle();
    // `subagent {sessionID}` continues an existing child: no session.created this turn
    launchChild(api, false);
    await settle();
    expect(api.rulesets.map((entry) => entry.sessionId)).toEqual([CHILD]);
    expect(api.rulesets[0]?.permissions).toEqual(session.ruleset());
    await session.interrupt();
    expect(api.interruptedSessions).toEqual([api.sessionId, CHILD]);
    api.emit("session.execution.interrupted", { reason: "user" });
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
  });

  it("does not re-apply the ruleset to a child created in this turn (it copied the parent's)", async () => {
    const { session, api } = harness();
    const done = collect(session.send({ text: "go" }), []);
    await settle();
    launchChild(api);
    await settle();
    expect(api.rulesets).toEqual([]);
    api.succeeded();
    await done;
  });

  it("closing the session mid-turn stops following its children", async () => {
    const { session, api, hub } = harness();
    const done = collect(session.send({ text: "go" }), []);
    await settle();
    launchChild(api);
    await settle();
    expect(hub.followed).toBe(1);
    await session.close();
    await done;
    expect(hub.followed).toBe(0);
  });
});
