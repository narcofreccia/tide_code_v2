import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { AppServer } from "./app-server.ts";
import { fakeSpawn, type FakeAppServer } from "./fake-app-server.ts";
import { CodexSession } from "./session.ts";
import type { CodexConfig, SpawnFn, TimerLike } from "./types.ts";

const THREAD = "thread-1";
const TURN = "turn-1";

async function harness(overrides: Partial<OpenSessionOptions> = {}, config: Partial<CodexConfig> = {}): Promise<{ session: CodexSession; server: FakeAppServer; logs: string[] }> {
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (message) => logs.push(message) };
  const { spawn, last } = fakeSpawn();
  const options: OpenSessionOptions = { threadId: "t1", cwd: "/tmp/repo", mode: "approval-required", interaction: "default", mcpServers: [], ...overrides };
  const session = await CodexSession.open({ spawnImpl: spawn, ...config }, env, options, "/usr/bin/codex");
  return { session, server: last(), logs };
}

/** Deterministic stand-in for `setTimeout`: the test decides when a deadline fires. */
function fakeTimers(): TimerLike & { run(): void; pending: number } {
  const scheduled = new Map<number, () => void>();
  let next = 1;
  return {
    setTimeout(fn) {
      const handle = next++;
      scheduled.set(handle, fn);
      return handle;
    },
    clearTimeout(handle) {
      scheduled.delete(handle as number);
    },
    run() {
      for (const fn of [...scheduled.values()]) fn();
      scheduled.clear();
    },
    get pending() {
      return scheduled.size;
    },
  };
}

/** Collects the turn's events, letting the test drive the server between yields. */
function collect(stream: AsyncIterable<NormalizedEvent>): { events: NormalizedEvent[]; done: Promise<void> } {
  const events: NormalizedEvent[] = [];
  const done = (async () => {
    for await (const event of stream) events.push(event);
  })();
  return { events, done };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function completeTurn(server: FakeAppServer, status = "completed"): void {
  server.notify("turn/completed", { threadId: THREAD, turn: { id: TURN, status, items: [], itemsView: "notLoaded", error: null } });
}

describe("codex session", () => {
  it("handshakes, starts a thread and reports the codex threadId as the native session id", async () => {
    const { session, server } = await harness();
    expect(session.nativeSessionId).toBe(THREAD);
    expect(server.args).toEqual(["app-server"]);
    expect(server.written[0]?.method).toBe("initialize");
    expect(server.written[0]?.params?.["clientInfo"]).toEqual({ name: "tide", title: "Tide", version: "2.0.0" });
    expect(server.written[1]?.method).toBe("initialized");
    expect(server.calls("thread/start")[0]).toMatchObject({ cwd: "/tmp/repo", approvalPolicy: "untrusted", sandbox: "workspace-write" });
    await session.close();
    expect(server.killed).toBe(1);
  });

  it("resumes an existing thread and passes the user's MCP servers as merging -c overrides", async () => {
    const { session, server } = await harness({
      resume: "thread-existing",
      mode: "full-access",
      mcpServers: [{ name: "tide", command: "node", args: ["mcp.js"], env: { TOKEN: "x" } }],
    });
    expect(server.calls("thread/resume")[0]).toMatchObject({ threadId: "thread-existing", approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(server.calls("thread/start")).toHaveLength(0);
    expect(server.args).toEqual(["app-server", "-c", 'mcp_servers.tide.command="node"', "-c", 'mcp_servers.tide.args=["mcp.js"]', "-c", 'mcp_servers.tide.env_vars=["TOKEN"]']);
    expect(server.env["TOKEN"]).toBe("x");
    await session.close();
  });

  it("runs one turn end to end and refuses a second one while it is running", async () => {
    const { session, server } = await harness();
    const { events, done } = collect(session.send({ text: "hi" }));
    await tick();
    expect(() => session.send({ text: "again" })).toThrow(/busy/);

    const params = server.calls("turn/start")[0]!;
    expect(params["threadId"]).toBe(THREAD);
    expect(params["input"]).toEqual([{ type: "text", text: "hi", text_elements: [] }]);
    expect(params["sandboxPolicy"]).toMatchObject({ type: "workspaceWrite", writableRoots: ["/tmp/repo"] });
    expect(params["collaborationMode"]).toEqual({ mode: "default", settings: { model: "gpt-5.6-sol", reasoning_effort: null, developer_instructions: null } });

    server.notify("item/agentMessage/delta", { threadId: THREAD, turnId: TURN, itemId: "m1", delta: "codex-ok" });
    completeTurn(server);
    await done;
    expect(events).toEqual([
      { type: "assistant.delta", messageKey: "m1", delta: "codex-ok" },
      { type: "settled", status: "completed" },
    ]);
    // the stream ended, so a follow-up turn is allowed again
    const second = collect(session.send({ text: "more" }));
    completeTurn(server);
    await second.done;
    await session.close();
  });

  it("plan interaction asks for codex's own plan collaboration mode", async () => {
    const { session, server } = await harness({ interaction: "plan" });
    const { events, done } = collect(session.send({ text: "plan it" }));
    await tick();
    expect(server.calls("turn/start")[0]?.["collaborationMode"]).toMatchObject({ mode: "plan" });

    server.notify("item/plan/delta", { threadId: THREAD, turnId: TURN, itemId: "p1", delta: "## Plan\n- step one\n" });
    server.notify("item/completed", { threadId: THREAD, turnId: TURN, item: { type: "plan", id: "p1", text: "" } });
    completeTurn(server);
    await done;
    expect(events[0]).toEqual({ type: "plan.proposed", markdown: "## Plan\n- step one\n" });
    await session.close();
  });

  it("parks a command approval as an activity and answers the same json-rpc id", async () => {
    const { session, server } = await harness();
    const { events, done } = collect(session.send({ text: "run it" }));
    await tick();
    server.notify("item/fileChange/patchUpdated", { threadId: THREAD, turnId: TURN, itemId: "i9", changes: [{ path: "a.ts", kind: { type: "update", move_path: null }, diff: "@@\n+x\n" }] });
    server.serverRequest("srv-1", "item/commandExecution/requestApproval", { threadId: THREAD, turnId: TURN, itemId: "i8", startedAtMs: 1, command: "rm -rf build", cwd: "/tmp/repo", reason: "outside the sandbox" });
    server.serverRequest("srv-2", "item/fileChange/requestApproval", { threadId: THREAD, turnId: TURN, itemId: "i9", startedAtMs: 1 });
    await tick();

    const approvals = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "approval" ? [event.activity] : []));
    expect(approvals[0]).toMatchObject({ requestId: "srv-1", toolName: "Bash", status: "pending", description: "outside the sandbox" });
    expect(approvals[0]?.input).toEqual({ command: "rm -rf build", cwd: "/tmp/repo", reason: "outside the sandbox" });
    expect(approvals[1]).toMatchObject({ requestId: "srv-2", toolName: "Edit", diff: "@@\n+x\n" });

    await session.respondApproval("srv-1", "decline");
    await session.respondApproval("srv-2", "acceptAlways");
    await tick();
    expect(server.replyTo("srv-1")?.result).toEqual({ decision: "decline" });
    // codex has no persistent grant on these requests, so acceptAlways lands on the session grant
    expect(server.replyTo("srv-2")?.result).toEqual({ decision: "acceptForSession" });

    completeTurn(server);
    await done;
    await session.close();
  });

  it("round trips a user-input request, keyed by question id and valued by option label", async () => {
    const { session, server } = await harness();
    const { events, done } = collect(session.send({ text: "ask me" }));
    await tick();
    server.serverRequest(42, "item/tool/requestUserInput", {
      threadId: THREAD,
      turnId: TURN,
      itemId: "i1",
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        { id: "q1", header: "Scope", question: "Which package?", isOther: false, isSecret: false, options: [{ label: "server", description: "apps/server" }, { label: "web", description: "apps/web" }] },
        { id: "q2", header: "Depth", question: "How deep?", isOther: false, isSecret: false, options: null },
      ],
    });
    await tick();

    const request = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "user-input" ? [event.activity] : []))[0];
    expect(request).toMatchObject({ requestId: "42", status: "pending" });
    expect(request?.questions[0]).toEqual({ id: "q1", text: "Which package?", options: [{ label: "server", description: "apps/server" }, { label: "web", description: "apps/web" }] });
    expect(request?.questions[1]).toEqual({ id: "q2", text: "How deep?" });

    await session.respondUserInput("42", { q1: "server", q2: ["deep", "wide"], stale: "ignored" });
    await tick();
    expect(server.replyTo(42)?.result).toEqual({ answers: { q1: { answers: ["server"] }, q2: { answers: ["deep", "wide"] } } });

    completeTurn(server);
    await done;
    await session.close();
  });

  it("declines server requests it does not model so the app-server never hangs", async () => {
    const { session, server, logs } = await harness();
    const { done } = collect(session.send({ text: "hi" }));
    await tick();
    server.serverRequest("srv-9", "attestation/generate", {});
    await tick();
    expect(server.replyTo("srv-9")?.error).toMatchObject({ code: -32601 });
    expect(logs.some((line) => line.includes("attestation/generate"))).toBe(true);
    completeTurn(server);
    await done;
    await session.close();
  });

  it("interrupt() interrupts the live turn, cancels pending approvals and settles as interrupted", async () => {
    const { session, server } = await harness();
    const { events, done } = collect(session.send({ text: "long job" }));
    await tick();
    server.notify("turn/started", { threadId: THREAD, turn: { id: TURN, status: "inProgress" } });
    server.serverRequest("srv-3", "item/commandExecution/requestApproval", { threadId: THREAD, turnId: TURN, itemId: "i1", startedAtMs: 1, command: "sleep 100", cwd: "/tmp/repo" });
    await tick();

    await session.interrupt();
    await tick();
    expect(server.calls("turn/interrupt")[0]).toEqual({ threadId: THREAD, turnId: TURN });
    expect(server.replyTo("srv-3")?.result).toEqual({ decision: "cancel" });

    completeTurn(server, "interrupted");
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
    await session.close();
  });

  it("settles as error when turn/start is rejected, and rejects sends after close()", async () => {
    const { session, server } = await harness();
    server.failMethods.set("turn/start", "no active model");
    const { events, done } = collect(session.send({ text: "hi" }));
    await done;
    expect(events).toEqual([{ type: "settled", status: "error", error: "no active model" }]);
    await session.close();
    expect(() => session.send({ text: "hi" })).toThrow(/closed/);
  });

  it("settles the running turn when the app-server dies instead of leaving it hanging", async () => {
    const { session, server } = await harness();
    const { events, done } = collect(session.send({ text: "hi" }));
    await tick();
    expect(server.calls("turn/start")).toHaveLength(1);

    // turn/start already resolved, so rejecting pending calls settles nothing on its own
    server.exit(9);
    await done;

    expect(events.at(-1)).toEqual({ type: "settled", status: "error", error: "codex app-server exited (code 9)" });
    expect(() => session.send({ text: "again" })).toThrow(/closed/);
  });

  it("reports a dead app-server as interrupted when the user asked to interrupt", async () => {
    const { session, server } = await harness();
    const { events, done } = collect(session.send({ text: "hi" }));
    await tick();
    await session.interrupt();
    server.exit(null);
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted", error: "codex app-server exited (code null)" });
  });

  it("gives up on an app-server that never answers initialize, and kills it", async () => {
    const timers = fakeTimers();
    const { spawn, last } = fakeSpawn();
    // the fake answers synchronously, so it has to be muted before the handshake is written
    const mute: SpawnFn = (command, args, options) => {
      const server = spawn(command, args, options) as FakeAppServer;
      server.silentMethods.add("initialize");
      return server;
    };
    const started = AppServer.start({
      binaryPath: "/usr/bin/codex",
      cwd: "/tmp/repo",
      env: {},
      spawn: mute,
      log: () => undefined,
      timers,
      initializeTimeoutMs: 45_000,
    });
    timers.run();
    await expect(started).rejects.toThrow(/did not answer initialize within 45000ms/);
    expect(last().killed).toBeGreaterThan(0);
  });

  it("escalates SIGTERM to SIGKILL when the app-server refuses to exit", async () => {
    const timers = fakeTimers();
    const { spawn, last } = fakeSpawn();
    const server = await AppServer.start({ binaryPath: "/usr/bin/codex", cwd: "/tmp/repo", env: {}, spawn, log: () => undefined, timers, killGraceMs: 5_000 });
    last().ignoreSigterm = true;
    server.close();
    expect(last().signals).toEqual(["SIGTERM"]);
    timers.run();
    expect(last().signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  it("does not SIGKILL an app-server that exited on SIGTERM", async () => {
    const timers = fakeTimers();
    const { spawn, last } = fakeSpawn();
    const server = await AppServer.start({ binaryPath: "/usr/bin/codex", cwd: "/tmp/repo", env: {}, spawn, log: () => undefined, timers });
    server.close();
    expect(last().signals).toEqual(["SIGTERM"]);
    expect(timers.pending).toBe(0);
  });

  it("passes MCP secrets through the app-server's environment, never on its command line", async () => {
    const { session, server } = await harness({ mcpServers: [{ name: "tide", command: "node", args: ["mcp.js"], env: { TIDE_AGENT_TOKEN: "s3cret" } }] });
    expect(server.args.join(" ")).not.toContain("s3cret");
    expect(server.args).toContain('mcp_servers.tide.env_vars=["TIDE_AGENT_TOKEN"]');
    expect(server.env["TIDE_AGENT_TOKEN"]).toBe("s3cret");
    await session.close();
  });

  it("sends images as data-url input parts alongside the text", async () => {
    const { session, server } = await harness();
    const { done } = collect(session.send({ text: "what is this?", images: [{ mediaType: "image/png", data: "AAAB" }] }));
    await tick();
    expect(server.calls("turn/start")[0]?.["input"]).toEqual([
      { type: "image", url: "data:image/png;base64,AAAB" },
      { type: "text", text: "what is this?", text_elements: [] },
    ]);
    completeTurn(server);
    await done;
    await session.close();
  });
});
