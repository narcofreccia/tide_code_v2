import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { RpcError } from "@tide/contracts";
import { createApp, type App } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import { createFakeDriver, emit, type FakeDriverControl } from "../provider/testing/fakeDriver.ts";
import { WsTestClient } from "./testing/wsClient.ts";

const TOKEN = "agent-test-token";
const config: ServerConfig = {
  tideHome: "/tmp/tide-agent-test",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-agent",
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
let sessionId: string;
let otherSessionId: string;
let threads: { perf: string; api: string; lead: string };
let agent: WsTestClient;
let client: WsTestClient;

async function panelIn(projectId: string, topic: string): Promise<string> {
  const created = (
    await app.engine.dispatch({
      type: "experts.create",
      projectId,
      topic,
      experts: [
        { key: "perf", name: "Pat", role: "performance", provider: "claude" },
        { key: "api", name: "Ana", role: "API design", provider: "claude" },
      ],
      lead: { provider: "claude" },
    })
  ).events[0]?.event;
  if (created?.type !== "experts.created") throw new Error("expected experts.created");
  return created.session.id;
}

beforeAll(async () => {
  const fake = createFakeDriver("claude");
  control = fake.control;
  app = await createApp({ config, log: () => undefined, registerDrivers: (registry) => registry.register(fake.driver) });
  const project = (await app.engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  sessionId = await panelIn(project.project.id, "caching");
  otherSessionId = await panelIn(project.project.id, "auth");

  control.script(emit({ type: "settled", status: "completed" }));
  control.script(emit({ type: "settled", status: "completed" }));
  await app.engine.dispatch({ type: "experts.start", sessionId });
  await app.reactor.drain();
  await app.experts.drain();

  const session = app.engine.getModel().expertsSessions[sessionId];
  threads = {
    perf: session?.experts[0]?.threadId as string,
    api: session?.experts[1]?.threadId as string,
    lead: session?.lead.threadId as string,
  };
  const url = app.server?.url ?? "";
  agent = await WsTestClient.open(`${url}?agentToken=${app.agentTokens.getOrCreate(threads.perf)}`);
  client = await WsTestClient.open(`${url}?token=${TOKEN}`);
});

afterAll(async () => {
  agent.close();
  client.close();
  await app.close();
});

describe("agent connection privileges", () => {
  it("rejects a bogus agent token at the handshake", async () => {
    const code = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`${app.server?.url ?? ""}?agentToken=nope`);
      ws.once("close", (c) => resolve(c));
      ws.once("error", () => resolve(-1));
    });
    expect(code).toBe(4401);
  });

  it("denies client methods on an agent socket", async () => {
    const err = await agent.expectError("orchestration.dispatch", {
      command: { type: "thread.archive", threadId: threads.perf },
    });
    expect(err.code).toBe("forbidden");
    expect((await agent.expectError("model.get", {})).code).toBe("forbidden");
  });

  it("denies agent methods on a client socket", async () => {
    expect((await client.expectError("agent.context", {})).code).toBe("forbidden");
    expect((await client.expectError("agent.threadStatus", { threadId: threads.api })).code).toBe("forbidden");
  });

  it("denies experts commands aimed at another session", async () => {
    const err = await agent.expectError("agent.dispatch", {
      command: { type: "experts.finding.post", sessionId: otherSessionId, author: "perf", text: "x" },
    });
    expect(err.code).toBe("forbidden");
  });

  it("lets only the lead set the synthesis", async () => {
    const err = await agent.expectError("agent.dispatch", {
      command: { type: "experts.synthesis.set", sessionId, markdown: "# nope" },
    });
    expect(err.code).toBe("forbidden");
  });
});

describe("agent.context", () => {
  it("reports the panel and filters messages by sinceMessageId", async () => {
    control.scriptFor(threads.perf, emit({ type: "settled", status: "completed" }));
    control.scriptFor(threads.perf, emit({ type: "settled", status: "completed" }));
    await app.engine.dispatch({ type: "experts.post", sessionId, to: "perf", text: "one" });
    await app.reactor.drain();
    await app.engine.dispatch({ type: "experts.post", sessionId, to: "perf", text: "two" });
    await app.reactor.drain();
    await app.experts.drain();

    const all = await agent.call<{
      expertKey?: string;
      role?: string;
      session?: { topic: string; experts: { key: string }[] };
      messages: { id: string; text: string }[];
    }>("agent.context", {});
    expect(all.expertKey).toBe("perf");
    expect(all.role).toBe("expert");
    expect(all.session?.topic).toBe("caching");
    expect(all.session?.experts.map((e) => e.key)).toEqual(["perf", "api"]);
    expect(all.messages.map((m) => m.text)).toEqual(["one", "two"]);

    const since = await agent.call<{ messages: { text: string }[] }>("agent.context", { sinceMessageId: all.messages[0]?.id });
    expect(since.messages.map((m) => m.text)).toEqual(["two"]);
  });

  it("hides messages addressed to another expert", async () => {
    control.scriptFor(threads.api, emit({ type: "settled", status: "completed" }));
    await app.engine.dispatch({ type: "experts.post", sessionId, to: "api", text: "private" });
    await app.reactor.drain();
    await app.experts.drain();
    const ctx = await agent.call<{ messages: { text: string }[] }>("agent.context", {});
    expect(ctx.messages.map((m) => m.text)).not.toContain("private");
  });
});

describe("thread.delegate", () => {
  it("runs a child thread on the driver and reports it back", async () => {
    control.script(emit({ type: "assistant.delta", messageKey: "m", delta: "measured it" }), emit({ type: "settled", status: "completed" }));
    const result = await agent.call<{ events: { event: { type: string; thread?: { id: string } } }[] }>("agent.dispatch", {
      command: { type: "thread.delegate", fromThreadId: "ignored", provider: "claude", prompt: "measure the loop" },
    });
    const created = result.events.find((r) => r.event.type === "thread.created");
    const childId = created?.event.thread?.id as string;
    expect(childId).toBeDefined();
    await app.reactor.drain();

    const status = await agent.call<{ status: string; settled: boolean; lastAssistantText?: string }>("agent.threadStatus", { threadId: childId });
    expect(status).toMatchObject({ status: "idle", settled: true, lastAssistantText: "measured it" });
    // fromThreadId is stamped from the socket, not the payload
    expect(app.engine.getModel().threads[childId]?.delegatedBy).toBe(threads.perf);
  });

  it("refuses status for an unrelated thread", async () => {
    const stranger = (
      await app.engine.dispatch({
        type: "thread.create",
        projectId: app.engine.getModel().expertsSessions[sessionId]?.projectId as string,
        provider: "claude",
      })
    ).events[0]?.event;
    if (stranger?.type !== "thread.created") throw new Error("expected thread.created");
    const err: RpcError = await agent.expectError("agent.threadStatus", { threadId: stranger.thread.id });
    expect(err.code).toBe("forbidden");
  });
});
