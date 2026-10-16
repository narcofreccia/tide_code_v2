import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AgentThreadSummary, AgentTimelineItem, DomainEvent, RuntimeMode } from "@tide/contracts";
import { createApp, type App } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import { awaitInterrupt, awaitUserInput, createFakeDriver, emit, type FakeDriverControl } from "../provider/testing/fakeDriver.ts";
import { waitForThread, type CancelTimer } from "./agentThreads.ts";
import { WsTestClient } from "./testing/wsClient.ts";

const TOKEN = "agent-threads-token";
const config: ServerConfig = {
  tideHome: "/tmp/tide-agent-threads-test",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-agent-threads",
  token: TOKEN,
  host: "127.0.0.1",
  port: 0,
  dev: true,
  printToken: false,
  corsOrigins: [],
  version: "0.0.0-test",
  providers: {},
};

let app: App;
let control: FakeDriverControl;
let agent: WsTestClient;
let client: WsTestClient;
let projectId: string;
let caller: string;

async function thread(title: string, mode: RuntimeMode = "approval-required", inProject = projectId): Promise<string> {
  const event = (await app.engine.dispatch({ type: "thread.create", projectId: inProject, provider: "claude", title, mode })).events[0]?.event;
  if (event?.type !== "thread.created") throw new Error("expected thread.created");
  return event.thread.id;
}

function waitFor(match: (event: DomainEvent) => boolean): Promise<DomainEvent> {
  return new Promise((resolve) => {
    const off = app.engine.subscribe((record) => {
      if (!match(record.event)) return;
      off();
      resolve(record.event);
    });
  });
}

beforeAll(async () => {
  const fake = createFakeDriver("claude");
  control = fake.control;
  control.setCaps({ steer: true });
  app = await createApp({ config, log: () => undefined, registerDrivers: (registry) => registry.register(fake.driver) });
  const project = (await app.engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  projectId = project.project.id;
  caller = await thread("Caller", "auto-accept-edits");
  agent = await WsTestClient.open(`${app.server?.url ?? ""}?agentToken=${app.agentTokens.getOrCreate(caller)}`);
  client = await WsTestClient.open(`${app.server?.url ?? ""}?token=${TOKEN}`);
});

afterAll(async () => {
  agent.close();
  client.close();
  await app.close();
});

describe("agent thread tools: scope", () => {
  it("are agent-only", async () => {
    expect((await client.expectError("agent.thread.list", {})).code).toBe("forbidden");
  });

  it("list the caller's project only, delegates on request", async () => {
    const reviewer = await thread("Reviewer");
    const other = (await app.engine.dispatch({ type: "project.create", title: "Other", rootPath: "/other" })).events[0]?.event;
    if (other?.type !== "project.created") throw new Error("expected project");
    const stranger = await thread("Stranger", "approval-required", other.project.id);
    control.script(emit({ type: "settled", status: "completed" }));
    await app.engine.dispatch({ type: "thread.delegate", fromThreadId: caller, provider: "claude", prompt: "help", title: "Helper" });
    await app.reactor.drain();

    const listed = await agent.call<{ threads: AgentThreadSummary[] }>("agent.thread.list", {});
    const titles = listed.threads.map((t) => t.title);
    expect(titles).toContain("Reviewer");
    expect(titles).not.toContain("Stranger");
    expect(titles).not.toContain("Helper");
    const withDelegates = await agent.call<{ threads: AgentThreadSummary[] }>("agent.thread.list", { includeDelegates: true, title: "help" });
    expect(withDelegates.threads.map((t) => t.title)).toEqual(["Helper"]);
    expect(withDelegates.threads[0]).toMatchObject({ delegatedBy: caller, worktree: false, limited: false });
    expect((await agent.call<{ threads: unknown[] }>("agent.thread.list", { projectId: other.project.id })).threads).toEqual([]);
    expect((await agent.expectError("agent.thread.read", { threadId: stranger })).code).toBe("forbidden");
    expect((await agent.expectError("agent.thread.send", { threadId: stranger, text: "hi" })).code).toBe("forbidden");
    expect(reviewer).toBeDefined();
  });

  it("refuse to drive a thread with broader permissions than the caller", async () => {
    const root = await thread("Root", "full-access");
    expect((await agent.expectError("agent.thread.send", { threadId: root, text: "rm -rf" })).code).toBe("forbidden");
  });
});

describe("agent thread tools: read / send / wait", () => {
  it("reads messages in bounded, truncated pages", async () => {
    const target = await thread("Reader");
    control.script(emit({ type: "assistant.delta", messageKey: "m", delta: "x".repeat(500) }), emit({ type: "settled", status: "completed" }));
    await app.engine.dispatch({ type: "turn.request", threadId: target, text: "question" });
    await app.reactor.drain();
    const page = await agent.call<{ items: AgentTimelineItem[]; nextPosition: number; truncated: boolean }>("agent.thread.read", { threadId: target, limit: 1, maxCharsPerItem: 200 });
    expect(page.items.map((i) => [i.kind, i.text])).toEqual([["user", "question"]]);
    expect(page.truncated).toBe(true);
    const rest = await agent.call<{ items: AgentTimelineItem[]; truncated: boolean }>("agent.thread.read", { threadId: target, afterPosition: page.nextPosition, maxCharsPerItem: 200 });
    expect(rest.items).toHaveLength(1);
    expect(rest.items[0]).toMatchObject({ kind: "assistant", truncated: true });
    expect(rest.items[0]?.text).toHaveLength(200);
    expect(rest.truncated).toBe(false);
  });

  it("starts an idle thread, steers a running one, and waits for it to settle", async () => {
    const target = await thread("Worker");
    control.scriptFor(target, emit({ type: "assistant.delta", messageKey: "m", delta: "on it" }), awaitInterrupt(), emit({ type: "settled", status: "completed" }));
    const streamed = waitFor((e) => e.type === "assistant.delta" && e.threadId === target);
    const started = await agent.call<{ delivered: string; turnId: string }>("agent.thread.send", { threadId: target, text: "do it" });
    expect(started.delivered).toBe("started");
    const prompt = app.engine.getModel().messages[Object.values(app.engine.getModel().messages).find((m) => m.turnId === started.turnId && m.role === "user")?.id ?? ""];
    expect(prompt?.notification).toEqual({ source: "system", summary: 'message from thread "Caller"' });
    await streamed;

    const steered = await agent.call<{ delivered: string }>("agent.thread.send", { threadId: target, text: "also this" });
    expect(steered.delivered).toBe("steered");
    const queued = await agent.call<{ delivered: string }>("agent.thread.send", { threadId: target, text: "later", mode: "queue" });
    expect(queued.delivered).toBe("queued");
    control.scriptFor(target, emit({ type: "assistant.delta", messageKey: "m", delta: "done later" }), emit({ type: "settled", status: "completed" }));

    await control.when(`steer:${target}`);
    const waiting = agent.call<{ settled: boolean; timedOut: boolean; status: string }>("agent.thread.wait", { threadId: target });
    expect(control.steers.map((s) => s.input.text)).toContain("also this");
    expect(await agent.call<{ ok: boolean }>("agent.thread.interrupt", { threadId: target })).toEqual({ ok: true });
    expect(await waiting).toMatchObject({ settled: true, timedOut: false });
    await app.reactor.drain();
    expect(await agent.call("agent.thread.wait", { threadId: target })).toMatchObject({ settled: true, status: "idle", lastAssistantText: "done later" });
  });

  it("returns the judge verdict when it is confident enough", async () => {
    const target = await thread("Judged");
    const verdict = (confidence: number) => ({ site: "delegates" as const, label: "done", confidence, source: "jev" as const, at: 1 });
    await app.engine.dispatch({ type: "judge.record", target: { kind: "thread", id: target }, verdict: verdict(0.9) });
    const grayZone = () => ({ low: 0.6, high: 0.85 });
    expect(await waitForThread(app.engine, target, undefined, 5_000, undefined, grayZone)).toMatchObject({ settled: true, judge: { label: "done", confidence: 0.9, source: "jev" } });
    expect(await waitForThread(app.engine, target, undefined, 5_000)).not.toHaveProperty("judge");
    await app.engine.dispatch({ type: "judge.record", target: { kind: "thread", id: target }, verdict: verdict(0.3) });
    expect(await waitForThread(app.engine, target, undefined, 5_000, undefined, grayZone)).not.toHaveProperty("judge");
  });

  it("times out without cancelling the turn", async () => {
    const target = await thread("Slow");
    control.scriptFor(target, emit({ type: "session", nativeSessionId: "slow-1" }), awaitInterrupt(), emit({ type: "settled", status: "completed" }));
    const running = waitFor((e) => e.type === "turn.started" && e.threadId === target);
    await app.engine.dispatch({ type: "turn.request", threadId: target, text: "slow" });
    await running;
    let fire: (() => void) | undefined;
    const schedule = (fn: () => void, ms: number): CancelTimer => {
      expect(ms).toBe(5_000);
      fire = fn;
      return () => undefined;
    };
    const waiting = waitForThread(app.engine, target, undefined, 5_000, schedule);
    fire?.();
    expect(await waiting).toMatchObject({ settled: false, timedOut: true, status: "running" });
    await app.engine.dispatch({ type: "turn.interrupt", threadId: target });
    await app.reactor.drain();
  });
});

describe("agent thread tools: pending questions", () => {
  it("lists a thread's open questions (never approvals) and answers them", async () => {
    const target = await thread("Asker");
    control.scriptFor(
      target,
      emit({ type: "activity", activity: { kind: "approval", requestId: "a1", toolName: "Bash", input: {}, status: "pending" } }),
      emit({ type: "activity", activity: { kind: "user-input", requestId: "q1", questions: [{ id: "db", text: "Which database?" }], status: "pending" } }),
      awaitUserInput("q1"),
      emit({ type: "settled", status: "completed" }),
    );
    const asked = waitFor((e) => e.type === "activity.upserted" && e.activity.kind === "user-input" && e.activity.threadId === target);
    await app.engine.dispatch({ type: "turn.request", threadId: target, text: "set up storage" });
    await asked;
    const pending = await agent.call<{ questions: { requestId: string; questions: { text: string }[] }[] }>("agent.pending.list", { threadId: target });
    expect(pending.questions.map((q) => [q.requestId, q.questions[0]?.text])).toEqual([["q1", "Which database?"]]);
    expect(await agent.call("agent.pending.respond", { threadId: target, requestId: "q1", answers: { db: "sqlite" } })).toEqual({ ok: true });
    await control.when("user-input:q1");
    expect(control.userInputs.at(-1)).toEqual({ requestId: "q1", answers: { db: "sqlite" } });
    await app.reactor.drain();
  });
});
