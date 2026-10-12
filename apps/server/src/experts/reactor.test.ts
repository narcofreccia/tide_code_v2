import { afterEach, describe, expect, it } from "vitest";
import type { McpServerSpec, OpenSessionOptions } from "@tide/contracts";
import { createApp, type App } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import { awaitApproval, createFakeDriver, effect, emit, type FakeDriverControl, type FakeStep } from "../provider/testing/fakeDriver.ts";
import { WsTestClient } from "../rpc/testing/wsClient.ts";

const config: ServerConfig = {
  tideHome: "/tmp/tide-experts-test",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-experts",
  token: "t",
  host: "127.0.0.1",
  port: 0,
  dev: true,
  printToken: false,
  corsOrigins: [],
  version: "0.0.0-test",
  providers: {},
};

function agentTokenOf(options: OpenSessionOptions): string {
  const tide = options.mcpServers.find((s: McpServerSpec) => s.name === "tide");
  const token = tide?.env?.["TIDE_AGENT_TOKEN"];
  if (token === undefined) throw new Error("session was not given a tide MCP server");
  return token;
}

/** Acts as the harness's MCP server would: connects with the thread's agent token. */
async function asAgent<T>(app: App, options: OpenSessionOptions, use: (client: WsTestClient) => Promise<T>): Promise<T> {
  const url = `${app.server?.url ?? ""}?agentToken=${agentTokenOf(options)}`;
  const client = await WsTestClient.open(url);
  try {
    return await use(client);
  } finally {
    client.close();
  }
}

interface Panel {
  app: App;
  control: FakeDriverControl;
  sessionId: string;
  threads: { perf: string; api: string; lead: string };
}

let panel: Panel | undefined;
/** set as soon as the app exists, so an effect running inside a turn can reach it */
let currentApp: App | undefined;

afterEach(async () => {
  await panel?.app.close();
  panel = undefined;
  currentApp = undefined;
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Boots an app, starts a two-expert panel and lets both exploration turns finish. */
async function startPanel(explore: (options: OpenSessionOptions) => Promise<void>): Promise<Panel> {
  const { driver, control } = createFakeDriver("claude");
  const app = await createApp({ config, log: () => undefined, registerDrivers: (registry) => registry.register(driver) });
  currentApp = app;
  const project = (await app.engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  const created = (
    await app.engine.dispatch({
      type: "experts.create",
      projectId: project.project.id,
      topic: "caching",
      experts: [
        { key: "perf", name: "Pat", role: "performance", provider: "claude" },
        { key: "api", name: "Ana", role: "API design", provider: "claude" },
      ],
      lead: { provider: "claude" },
    })
  ).events[0]?.event;
  if (created?.type !== "experts.created") throw new Error("expected experts.created");

  // both exploration turns run the same script; each session posts with its own token
  control.script(effect(explore), emit({ type: "settled", status: "completed" }));
  control.script(effect(explore), emit({ type: "settled", status: "completed" }));

  await app.engine.dispatch({ type: "experts.start", sessionId: created.session.id });
  await app.reactor.drain();
  await app.experts.drain();

  const session = app.engine.getModel().expertsSessions[created.session.id];
  if (!session) throw new Error("session gone");
  const threads = {
    perf: session.experts[0]?.threadId as string,
    api: session.experts[1]?.threadId as string,
    lead: session.lead.threadId as string,
  };
  const built: Panel = { app, control, sessionId: created.session.id, threads };
  panel = built;
  return built;
}

describe("experts end to end", () => {
  it("collects findings posted by both experts through agent.dispatch", async () => {
    const { app, sessionId } = await startPanel(async (options) => {
      await asAgent(panelApp(), options, async (client) => {
        const ctx = await client.call<{ session?: { id: string; topic: string }; expertKey?: string }>("agent.context", {});
        await client.call("agent.dispatch", {
          command: { type: "experts.finding.post", sessionId: ctx.session?.id, author: "spoofed", text: `finding from ${ctx.expertKey}` },
        });
      });
    });

    const model = app.engine.getModel();
    const session = model.expertsSessions[sessionId];
    const findings = (session?.findingIds ?? []).map((id) => model.expertsFindings[id]);
    expect(findings).toHaveLength(2);
    // author is stamped from the authenticated thread, never from the payload
    expect(findings.map((f) => f?.author).sort()).toEqual(["api", "perf"]);
    expect(findings.map((f) => f?.text).sort()).toEqual(["finding from api", "finding from perf"]);
    expect(session?.experts.every((e) => e.status === "idle")).toBe(true);
  });

  it("queues a message for a busy expert as a turn that runs once the current one settles", async () => {
    const { app, control, sessionId, threads } = await startPanel(async () => undefined);

    const running = deferred();
    const gate: FakeStep[] = [
      effect(() => {
        running.resolve();
      }),
      awaitApproval("gate"),
      emit({ type: "settled", status: "completed" }),
    ];
    control.scriptFor(threads.api, ...gate);
    control.scriptFor(threads.api, emit({ type: "settled", status: "completed" }));

    await app.engine.dispatch({ type: "experts.post", sessionId, to: "api", text: "first" });
    await running.promise;
    expect(app.engine.getModel().threads[threads.api]?.status).toBe("running");

    await app.engine.dispatch({ type: "experts.post", sessionId, to: "api", text: "second" });
    await app.experts.drain();
    // the backlog is a queued turn in the event log, not an in-memory mailbox
    const queued = Object.values(app.engine.getModel().turns).filter((t) => t.threadId === threads.api && t.status === "queued");
    expect(queued).toHaveLength(1);

    await control.sessionFor(threads.api)?.respondApproval("gate", "accept");
    await app.reactor.drain();
    await app.experts.drain();

    const model = app.engine.getModel();
    const texts = (model.threadMessages[threads.api] ?? []).map((id) => model.messages[id]?.text ?? "");
    expect(texts.some((t) => t.includes("Message from user: first"))).toBe(true);
    expect(texts.some((t) => t.includes("Message from user: second"))).toBe(true);
    expect(Object.values(model.turns).filter((t) => t.threadId === threads.api && t.status !== "completed")).toHaveLength(0);
    expect(control.sessionFor(threads.api)?.inputs.map((i) => i.text).filter((t) => t.includes("Message from user"))).toHaveLength(2);
    // the other expert was not addressed
    expect((model.threadMessages[threads.perf] ?? []).some((id) => model.messages[id]?.text.includes("Message from user"))).toBe(false);
  });

  it("records the lead's synthesis as a proposed plan on the lead thread", async () => {
    const { app, control, sessionId, threads } = await startPanel(async () => undefined);

    control.scriptFor(threads.perf, emit({ type: "settled", status: "completed" }));
    control.scriptFor(threads.api, emit({ type: "settled", status: "completed" }));
    control.scriptFor(
      threads.lead,
      effect(async (options) => {
        await asAgent(panelApp(), options, async (client) => {
          const ctx = await client.call<{ session?: { id: string } }>("agent.context", {});
          await client.call("agent.dispatch", {
            command: { type: "experts.synthesis.set", sessionId: ctx.session?.id, markdown: "# Decision\nCache at the edge." },
          });
        });
      }),
      emit({ type: "settled", status: "completed" }),
    );

    await app.engine.dispatch({ type: "experts.set-phase", sessionId, phase: "discussing" });
    await app.reactor.drain();
    await app.engine.dispatch({ type: "experts.set-phase", sessionId, phase: "synthesizing" });
    await app.reactor.drain();
    await app.experts.drain();

    const model = app.engine.getModel();
    const session = model.expertsSessions[sessionId];
    expect(session?.phase).toBe("ready");
    const planId = session?.synthesis?.planId as string;
    expect(model.plans[planId]).toMatchObject({ status: "proposed", threadId: threads.lead });
    expect(model.plans[planId]?.markdown).toContain("Cache at the edge");
  });
});

function panelApp(): App {
  if (!currentApp) throw new Error("app not started");
  return currentApp;
}
