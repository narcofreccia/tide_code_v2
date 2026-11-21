import { describe, expect, it } from "vitest";
import type { AgentCommand, ProviderStatusDto, RpcFrame, RpcOutput, UserSettings } from "@tide/contracts";
import { Engine } from "../orchestration/engine.ts";
import { openEventStore } from "../orchestration/store.ts";
import { registerAgentHandlers } from "./agent.ts";
import type { AgentRegistryView } from "./agentModel.ts";
import { RpcRouter } from "./router.ts";

// R23: model ids an agent passes are checked against the target harness's own list.

const CAPS = { planMode: true, subagents: true, mcp: true, images: true, resume: true, contextUsage: true, openInTerminal: true };
const dto = (id: string, kind: ProviderStatusDto["kind"], models: ProviderStatusDto["models"], patch: Partial<ProviderStatusDto> = {}): ProviderStatusDto => ({
  id,
  kind,
  label: id,
  installed: true,
  loggedIn: true,
  models,
  caps: CAPS,
  ...patch,
});

const STATUS: ProviderStatusDto[] = [
  dto("claude", "claude", [
    { id: "default", label: "Default", default: true },
    { id: "opus", label: "Opus 5.5" },
    { id: "sonnet", label: "Sonnet 5.5" },
  ]),
  dto("codex", "codex", [
    { id: "gpt-6.2-sol", label: "GPT-6.2-Sol", default: true },
    { id: "gpt-6.1", label: "GPT-6.1" },
  ], { loggedIn: false }),
  dto("codex:work", "codex", [{ id: "gpt-6.1", label: "GPT-6.1", default: true }]),
  dto("opencode", "opencode", [], { installed: false, loggedIn: false }),
];

class FakeRegistry implements AgentRegistryView {
  reads: string[] = [];
  refreshes: boolean[] = [];
  async status(id: string): Promise<ProviderStatusDto> {
    this.reads.push(id);
    return STATUS.find((s) => s.id === id) ?? dto(id, "acp", [], { installed: false, loggedIn: false });
  }
  async statusAll(refresh = false): Promise<ProviderStatusDto[]> {
    this.refreshes.push(refresh);
    return STATUS;
  }
}

type DispatchOut = RpcOutput<"agent.dispatch">;

async function setup(options: { registry?: FakeRegistry; defaults?: UserSettings["providerDefaults"] } = {}) {
  const store = await openEventStore(":memory:");
  const engine = new Engine({ store, defaults: () => ({ providerInstances: [{ id: "codex:work", kind: "codex" }] }) });
  const router = new RpcRouter();
  registerAgentHandlers(router, {
    engine,
    cwdFor: () => "/repo",
    ...(options.registry !== undefined ? { registry: options.registry } : {}),
    ...(options.defaults !== undefined ? { providerDefaults: () => options.defaults ?? {} } : {}),
  });
  const project = (await engine.dispatch({ type: "project.create", title: "P", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const caller = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "codex", title: "Lead", mode: "full-access" })).events[0]?.event;
  if (caller?.type !== "thread.created") throw new Error("expected thread");
  const frames: RpcFrame[] = [];
  const agent = router.connection("agent", (frame) => frames.push(frame), { agentThreadId: caller.thread.id });
  const client = router.connection("client", (frame) => frames.push(frame));
  let seq = 0;
  const call = async <T>(method: string, params: unknown, via = agent): Promise<{ result?: T; error?: { code: string; message: string } }> => {
    const id = `r${++seq}`;
    await via.handleRequest(id, method, params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as T };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error("no frame");
  };
  const dispatch = (command: Record<string, unknown>) => call<DispatchOut>("agent.dispatch", { command: command as AgentCommand });
  const createdThread = (out: DispatchOut | undefined) => {
    const e = out?.events.find((r) => r.event.type === "thread.created")?.event;
    return e?.type === "thread.created" ? e.thread : undefined;
  };
  const createdTask = (out: DispatchOut | undefined) => {
    const e = out?.events.find((r) => r.event.type === "task.created")?.event;
    return e?.type === "task.created" ? e.task : undefined;
  };
  return { engine, call, dispatch, createdThread, createdTask, client, store };
}

const delegate = (patch: Record<string, unknown>) => ({ type: "thread.delegate", fromThreadId: "self", provider: "claude", prompt: "go", ...patch });
const task = (patch: Record<string, unknown>) => ({ type: "task.create", projectId: "self", title: "Nightly", prompt: "go", schedule: { kind: "interval", everyMs: 3_600_000 }, ...patch });

describe("agent.dispatch — model ids", () => {
  it("rewrites a display-name model to the listed id and says so", async () => {
    const s = await setup({ registry: new FakeRegistry() });
    const { result } = await s.dispatch(delegate({ model: "opus-5.5" }));
    expect(s.createdThread(result)?.model).toBe("opus");
    expect(result?.modelNote).toBe("model `opus-5.5` is not an id claude lists; using `opus` (Opus 5.5)");
  });

  it("passes an unlisted id through unchanged, with a note listing the harness's ids", async () => {
    const registry = new FakeRegistry();
    const s = await setup({ registry });
    const { result } = await s.dispatch(delegate({ model: "claude-opus-5-5" }));
    expect(s.createdThread(result)?.model).toBe("claude-opus-5-5");
    expect(result?.modelNote).toBe(
      "model `claude-opus-5-5` is not in claude's list (default, opus, sonnet); passed as is. If the delegate fails on its model, use a listed id",
    );
    expect(registry.reads).toEqual(["claude"]);
  });

  it("reads the instance named by providerId, not the kind's default", async () => {
    const registry = new FakeRegistry();
    const s = await setup({ registry });
    const { result, error } = await s.dispatch(delegate({ provider: "codex", providerId: "codex:work", model: "GPT 6.1" }));
    expect(error).toBeUndefined();
    expect(s.createdThread(result)).toMatchObject({ providerId: "codex:work", model: "gpt-6.1" });
    expect(registry.reads).toEqual(["codex:work"]);
  });

  it("adds a not-signed-in or not-installed harness to the note without refusing", async () => {
    const s = await setup({ registry: new FakeRegistry() });
    const signedOut = await s.dispatch(delegate({ provider: "codex", model: "gpt-6.2-sol" }));
    expect(s.createdThread(signedOut.result)?.model).toBe("gpt-6.2-sol");
    expect(signedOut.result?.modelNote).toBe("codex was not signed in at its last status check; a thread on it may fail to start");
    const missing = await s.dispatch(delegate({ provider: "opencode", model: "glm" }));
    expect(s.createdThread(missing.result)?.model).toBe("glm");
    expect(missing.result?.modelNote).toBe("opencode was not installed at its last status check; a thread on it may fail to start");
  });

  it("leaves a listed id alone without a note, and reads no status without a model", async () => {
    const registry = new FakeRegistry();
    const s = await setup({ registry });
    const listed = await s.dispatch(delegate({ model: "sonnet" }));
    expect(s.createdThread(listed.result)?.model).toBe("sonnet");
    expect(listed.result).not.toHaveProperty("modelNote");
    registry.reads = [];
    const plain = await s.dispatch(delegate({}));
    expect(s.createdThread(plain.result)?.model).toBeUndefined();
    expect(plain.result).not.toHaveProperty("modelNote");
    expect(registry.reads).toEqual([]);
  });

  it("checks a new-thread automation's model the same way", async () => {
    const registry = new FakeRegistry();
    const s = await setup({ registry });
    const resolved = await s.dispatch(task({ provider: "codex", model: "GPT-6.2-Sol" }));
    expect(s.createdTask(resolved.result)?.model).toBe("gpt-6.2-sol");
    expect(resolved.result?.modelNote).toContain("using `gpt-6.2-sol` (GPT-6.2-Sol)");
    const unlisted = await s.dispatch(task({ provider: "claude", model: "opus-4" }));
    expect(s.createdTask(unlisted.result)?.model).toBe("opus-4");
    expect(unlisted.result?.modelNote).toContain("is not in claude's list");
    registry.reads = [];
    // no provider: the project's default harness runs it, which this layer does not guess
    const noProvider = await s.dispatch(task({ model: "opus-5.5" }));
    expect(s.createdTask(noProvider.result)?.model).toBe("opus-5.5");
    expect(noProvider.result).not.toHaveProperty("modelNote");
    expect(registry.reads).toEqual([]);
  });

  it("behaves as before without a registry", async () => {
    const s = await setup();
    const { result } = await s.dispatch(delegate({ model: "opus-5.5" }));
    expect(s.createdThread(result)?.model).toBe("opus-5.5");
    expect(result).not.toHaveProperty("modelNote");
  });
});

describe("agent.harnesses", () => {
  it("maps every instance, with the default model from settings for the instance, then the kind, then the harness", async () => {
    const registry = new FakeRegistry();
    const s = await setup({ registry, defaults: { claude: { model: "sonnet" }, codex: { model: "gpt-6.1" } } });
    const { result } = await s.call<RpcOutput<"agent.harnesses">>("agent.harnesses", {});
    expect(result?.harnesses).toEqual([
      { provider: "claude", providerId: "claude", label: "claude", installed: true, loggedIn: true, defaultModel: "sonnet", models: [{ id: "default", label: "Default" }, { id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }] },
      { provider: "codex", providerId: "codex", label: "codex", installed: true, loggedIn: false, defaultModel: "gpt-6.1", models: [{ id: "gpt-6.2-sol", label: "GPT-6.2-Sol" }, { id: "gpt-6.1", label: "GPT-6.1" }] },
      // the kind's setting reaches a second account without its own
      { provider: "codex", providerId: "codex:work", label: "codex:work", installed: true, loggedIn: true, defaultModel: "gpt-6.1", models: [{ id: "gpt-6.1", label: "GPT-6.1" }] },
      { provider: "opencode", providerId: "opencode", label: "opencode", installed: false, loggedIn: false, models: [] },
    ]);
    expect(registry.refreshes).toEqual([false]);
  });

  it("prefers the instance's own setting, falls back to the harness's default, and passes refresh on", async () => {
    const registry = new FakeRegistry();
    const s = await setup({ registry, defaults: { codex: { model: "gpt-6.1" }, "codex:work": { model: "gpt-6.2-sol" } } });
    const { result } = await s.call<RpcOutput<"agent.harnesses">>("agent.harnesses", { refresh: true });
    const byId = Object.fromEntries((result?.harnesses ?? []).map((h) => [h.providerId, h.defaultModel]));
    expect(byId).toEqual({ claude: "default", codex: "gpt-6.1", "codex:work": "gpt-6.2-sol", opencode: undefined });
    expect(registry.refreshes).toEqual([true]);
  });

  it("answers agent sockets only", async () => {
    const s = await setup({ registry: new FakeRegistry() });
    const { error } = await s.call("agent.harnesses", {}, s.client);
    expect(error?.code).toBe("forbidden");
  });
});
