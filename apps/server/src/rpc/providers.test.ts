import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProviderStatusDto, SlashCommandInfo } from "@tide/contracts";
import { createApp, type App } from "../app.ts";
import type { ServerConfig } from "../config.ts";
import { AcpRegistry } from "../provider/acpRegistry.ts";
import { createInstanceFactory } from "../provider/instances.ts";
import { createFakeDriver, emit, type FakeDriverControl } from "../provider/testing/fakeDriver.ts";
import { WsTestClient } from "./testing/wsClient.ts";

const TOKEN = "providers-token";
const config: ServerConfig = {
  tideHome: "/tmp/tide-providers-test",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-providers",
  token: TOKEN,
  host: "127.0.0.1",
  port: 0,
  dev: true,
  printToken: false,
  corsOrigins: [],
  version: "0.0.0-test",
  providers: {},
};

const PROJECT_COMMANDS: SlashCommandInfo[] = [{ name: "review", description: "Review the diff", source: "custom" }];

let app: App;
let claude: FakeDriverControl;
let client: WsTestClient;
let projectId: string;

async function createThread(params: Record<string, unknown> = {}): Promise<string> {
  const result = await client.call<{ events: { event: { type: string; thread?: { id: string } } }[] }>("orchestration.dispatch", {
    command: { type: "thread.create", commandId: `c-${Math.random()}`, projectId, provider: "claude", useWorktree: false, ...params },
  });
  const id = result.events.find((r) => r.event.type === "thread.created")?.event.thread?.id;
  if (id === undefined) throw new Error("no thread");
  return id;
}

async function runTurn(threadId: string): Promise<void> {
  await app.engine.dispatch({ type: "turn.request", threadId, text: "go" });
  await app.reactor.drain();
}

beforeAll(async () => {
  const fake = createFakeDriver("claude");
  claude = fake.control;
  claude.commandsResult = PROJECT_COMMANDS;
  const offline = async (): Promise<never> => {
    throw new Error("offline");
  };
  const acp = new AcpRegistry({
    dataDir: ":memory:",
    fetch: offline,
    snapshot: { agents: [{ id: "gemini", name: "Gemini CLI", distribution: { npx: { package: "@google/gemini-cli" } } }, { id: "goose", name: "Goose", distribution: { binary: {} } }] },
  });
  app = await createApp({
    config,
    log: () => undefined,
    acp,
    registerDrivers: (registry) => registry.register(fake.driver),
    instanceFactory: (registry) => createInstanceFactory({ providers: {}, acp: registry, drivers: { claude: fake.driver } }),
  });
  const project = (await app.engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project.created");
  projectId = project.project.id;
  client = await WsTestClient.open(`${app.server?.url ?? ""}?token=${TOKEN}`);
});

afterAll(async () => {
  client.close();
  await app.close();
});

describe("providers.commands", () => {
  it("asks the thread's instance in its cwd once, then serves the 30 s cache", async () => {
    const threadId = await createThread();
    expect(await client.call("providers.commands", { threadId })).toEqual({ commands: PROJECT_COMMANDS });
    expect(await client.call("providers.commands", { threadId })).toEqual({ commands: PROJECT_COMMANDS });
    expect(claude.listCommandsCalls).toEqual(["/repo"]);
  });

  it("prefers the list a live session announced", async () => {
    const threadId = await createThread();
    const live: SlashCommandInfo[] = [{ name: "compact", source: "builtin" }];
    claude.scriptFor(threadId, emit({ type: "commands", commands: live }), emit({ type: "settled", status: "completed" }));
    await runTurn(threadId);
    expect(await client.call("providers.commands", { threadId })).toEqual({ commands: live });
  });

  it("is not-found for an unknown thread", async () => {
    expect(await client.expectError("providers.commands", { threadId: "nope" })).toMatchObject({ code: "not-found" });
  });
});

describe("provider instances over RPC", () => {
  it("adds an instance on settings.set, runs a thread on it, and defers disposal while its session lives", async () => {
    await client.call("settings.set", { patch: { providerInstances: [{ id: "claude:work", kind: "claude", label: "Claude (work)", home: "/acct/work" }] } });
    const list = await client.call<ProviderStatusDto[]>("providers.list", {});
    expect(list.map((p) => p.id)).toEqual(["claude", "codex", "opencode", "pi", "claude:work"]);
    expect(list[4]).toMatchObject({ kind: "claude", label: "Claude (work)", installed: true });

    const threadId = await createThread({ providerId: "claude:work", effort: "high" });
    claude.scriptFor(threadId, emit({ type: "settled", status: "completed" }));
    await runTurn(threadId);
    const created = claude.created.find((c) => c.env.instance?.id === "claude:work");
    expect(created?.config["env"]).toMatchObject({ CLAUDE_CONFIG_DIR: "/acct/work" });
    expect(claude.opened.at(-1)).toMatchObject({ threadId, effort: "high" });

    await client.call("settings.set", { patch: { providerInstances: [] } });
    expect((await client.call<ProviderStatusDto[]>("providers.list", {})).map((p) => p.id)).not.toContain("claude:work");
    expect(claude.disposed).not.toContain(created?.instance);
    await app.sessions.close(threadId);
    expect(claude.disposed).toContain(created?.instance);
  });

  it("refuses a thread on an unknown instance", async () => {
    const err = await client.expectError("orchestration.dispatch", {
      command: { type: "thread.create", commandId: "c-ghost", projectId, provider: "claude", providerId: "claude:ghost" },
    });
    expect(err).toMatchObject({ code: "invalid-command" });
  });

  it("lists the ACP registry with this machine's distribution and what is configured", async () => {
    await client.call("settings.set", { patch: { providerInstances: [{ id: "acp:gemini", kind: "acp", label: "Gemini", acpAgentId: "gemini" }] } });
    const { agents } = await client.call<{ agents: { id: string; distribution: string; configured?: boolean }[] }>("providers.acpRegistry", {});
    expect(agents).toEqual([
      { id: "gemini", name: "Gemini CLI", distribution: "npx", configured: true },
      { id: "goose", name: "Goose", distribution: "none" },
    ]);
    // no ACP driver in this test build: the instance is listed, greyed out
    const acp = (await client.call<ProviderStatusDto[]>("providers.list", {})).find((p) => p.id === "acp:gemini");
    expect(acp).toMatchObject({ kind: "acp", installed: false, hint: "no ACP driver in this build" });
    await client.call("settings.set", { patch: { providerInstances: [] } });
  });
});
