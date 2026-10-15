import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentCommand } from "@tide/contracts";
import type { AgentBackend, AgentContext, AgentDispatchResult, AgentThreadStatus, PendingRespondInput, ThreadListInput, ThreadReadInput, ThreadSendInput, ThreadWaitInput, ThreadWaitResult } from "./backend.ts";
import { createTideMcpServer } from "./server.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";
import { THREAD_TOOLS_HINT } from "./threadTools.ts";

/** In-process stand-in for the Tide server's `agent.*` methods. */
class FakeBackend implements AgentBackend {
  readonly commands: AgentCommand[] = [];
  readonly contextCalls: (string | undefined)[] = [];
  messages: AgentContext["messages"] = [];
  findings: AgentContext["findings"] = [];
  session: AgentContext["session"] | undefined = { id: "sess-1", topic: "caching", phase: "exploring", experts: [] };
  status: AgentThreadStatus = { status: "idle", settled: true, lastAssistantText: "done" };
  nextThreadId = "thread-child";

  async dispatch(command: AgentCommand): Promise<AgentDispatchResult> {
    this.commands.push(command);
    if (command.type !== "thread.delegate") return { seq: 1, events: [] };
    return {
      seq: 1,
      events: [
        {
          seq: 1,
          ts: 1,
          event: {
            type: "thread.created",
            thread: {
              id: this.nextThreadId,
              projectId: "p",
              title: "delegated",
              provider: command.provider,
              mode: "auto",
              interaction: "default",
              status: "idle",
              createdAt: 1,
              updatedAt: 1,
            },
          },
        },
      ],
    };
  }

  async context(sinceMessageId?: string): Promise<AgentContext> {
    this.contextCalls.push(sinceMessageId);
    const from = sinceMessageId === undefined ? 0 : this.messages.findIndex((m) => m.id === sinceMessageId) + 1;
    return {
      threadId: "thread-perf",
      role: "expert",
      expertKey: "perf",
      ...(this.session !== undefined ? { session: this.session } : {}),
      findings: this.findings,
      messages: this.messages.slice(from),
    };
  }

  async threadStatus(): Promise<AgentThreadStatus> {
    return this.status;
  }

  threadCalls: [string, unknown][] = [];
  failWith: (Error & { code?: string }) | undefined;
  waitResult: ThreadWaitResult = { status: "idle", settled: true, timedOut: false, lastAssistantText: "child done" };
  #rec<T>(name: string, input: unknown, out: T): Promise<T> {
    this.threadCalls.push([name, input]);
    return this.failWith ? Promise.reject(this.failWith) : Promise.resolve(out);
  }
  threadList(i: ThreadListInput) {
    return this.#rec("list", i, { threads: [{ id: "t1", projectId: "p", title: "Fix\nbug", provider: "claude" as const, status: "running", attention: "question", role: "review", worktree: true, limited: false, updatedAt: 1 }] });
  }
  threadRead(i: ThreadReadInput) {
    return this.#rec("read", i, {
      thread: { id: "t1", projectId: "p", title: "Fix bug", provider: "codex" as const, status: "idle", worktree: false, limited: false, updatedAt: 1 },
      items: [{ position: 4, turnId: "u1", kind: "assistant" as const, text: "hello", truncated: true, at: 1 }],
      nextPosition: 5,
      truncated: true,
    });
  }
  threadSend(i: ThreadSendInput) {
    return this.#rec("send", i, { turnId: "u2", delivered: "queued" as const });
  }
  threadWait(i: ThreadWaitInput) {
    return this.#rec("wait", i, this.waitResult);
  }
  threadInterrupt(threadId: string) {
    return this.#rec("interrupt", threadId, { ok: true });
  }
  taskList() {
    return this.#rec("taskList", undefined, { tasks: [{ id: "task-1", projectId: "p1", title: "Nightly lint", prompt: "run lint", schedule: { kind: "interval", everyMs: 3_600_000 }, enabled: true, runs: 2, nextRunAt: 1_700_000_000_000, createdAt: 1, updatedAt: 1 }] });
  }
  pendingList(threadId: string) {
    return this.#rec("pendingList", threadId, { questions: [{ requestId: "r1", activityId: "a", askedAt: 1, questions: [{ id: "q1", text: "Which?", options: [{ label: "A" }, { label: "B" }] }] }] });
  }
  pendingRespond(i: PendingRespondInput) {
    return this.#rec("pendingRespond", i, { ok: true });
  }

  close(): void {
    /* nothing to release */
  }
}

async function connect(backend: AgentBackend): Promise<Client> {
  const server = createTideMcpServer({ backend });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const firstText = (result: unknown): string => {
  const content = (result as { content?: { type: string; text?: string }[] }).content;
  return content?.[0]?.text ?? "";
};

describe("tide-mcp server", () => {
  it("lists every tool with a description and a schema", async () => {
    const client = await connect(new FakeBackend());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(TOOL_DEFINITIONS.map((t) => t.name));
    expect(tools.map((t) => t.name)).toEqual([
      "tide_experts_post_finding",
      "tide_experts_read_findings",
      "tide_experts_send_message",
      "tide_experts_check_messages",
      "tide_experts_synthesize",
      "tide_delegate",
      "tide_delegate_status",
      "tide_thread_list",
      "tide_thread_read",
      "tide_thread_send",
      "tide_thread_wait",
      "tide_thread_interrupt",
      "tide_pending_list",
      "tide_pending_respond",
      "tide_schedule_task",
      "tide_list_scheduled_tasks",
      "tide_update_scheduled_task",
      "tide_delete_scheduled_task",
      "tide_run_scheduled_task_now",
    ]);
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
    }
    await client.close();
  });

  it("posts a finding through agent.dispatch with the session it discovered", async () => {
    const backend = new FakeBackend();
    const client = await connect(backend);
    const result = await client.callTool({ name: "tide_experts_post_finding", arguments: { text: "n+1 in the loader" } });
    expect(firstText(result)).toContain("Finding posted");
    expect(backend.commands[0]).toMatchObject({ type: "experts.finding.post", sessionId: "sess-1", text: "n+1 in the loader" });
    await client.close();
  });

  it("returns only unread messages and advances the cursor", async () => {
    const backend = new FakeBackend();
    backend.messages = [
      { id: "m1", from: "api", to: "perf", text: "first", createdAt: 1 },
      { id: "m2", from: "lead", to: "all", text: "second", createdAt: 2 },
    ];
    const client = await connect(backend);
    const first = await client.callTool({ name: "tide_experts_check_messages", arguments: {} });
    expect(firstText(first)).toContain("first");
    expect(firstText(first)).toContain("second");
    const second = await client.callTool({ name: "tide_experts_check_messages", arguments: {} });
    expect(firstText(second)).toBe("No new messages.");
    expect(backend.contextCalls).toEqual([undefined, "m2"]);
    await client.close();
  });

  it("reads findings and reports an empty board honestly", async () => {
    const backend = new FakeBackend();
    const client = await connect(backend);
    expect(firstText(await client.callTool({ name: "tide_experts_read_findings", arguments: {} }))).toBe("No findings posted yet.");
    backend.findings = [{ id: "f1", author: "api", text: "leaky types", createdAt: 1 }];
    expect(firstText(await client.callTool({ name: "tide_experts_read_findings", arguments: {} }))).toContain("[api] leaky types");
    await client.close();
  });

  it("delegates and then reports the child thread's status", async () => {
    const backend = new FakeBackend();
    const client = await connect(backend);
    const delegated = await client.callTool({ name: "tide_delegate", arguments: { provider: "codex", prompt: "measure it" } });
    expect(firstText(delegated)).toContain('"threadId":"thread-child"');
    expect(firstText(delegated)).toContain("tide_delegate_status");
    expect(backend.commands[0]).toMatchObject({ type: "thread.delegate", provider: "codex", prompt: "measure it" });

    const status = await client.callTool({ name: "tide_delegate_status", arguments: { threadId: "thread-child" } });
    expect(firstText(status)).toContain('"settled": true');
    expect(firstText(status)).toContain("done");
    await client.close();
  });

  it("passes `repo` through so the delegate runs in a linked repository", async () => {
    const backend = new FakeBackend();
    const client = await connect(backend);
    await client.callTool({ name: "tide_delegate", arguments: { provider: "claude", prompt: "port the UI", repo: "frontend", useWorktree: true } });
    expect(backend.commands[0]).toMatchObject({ type: "thread.delegate", provider: "claude", repo: "frontend", useWorktree: true });

    // an omitted or empty repo means "this project's own repo" — never a `repo: ""`
    await client.callTool({ name: "tide_delegate", arguments: { provider: "claude", prompt: "x" } });
    await client.callTool({ name: "tide_delegate", arguments: { provider: "claude", prompt: "x", repo: "" } });
    expect(backend.commands[1]).not.toHaveProperty("repo");
    expect(backend.commands[2]).not.toHaveProperty("repo");
    await client.close();
  });

  it("tells the agent what `repo` is for", () => {
    const delegate = TOOL_DEFINITIONS.find((tool) => tool.name === "tide_delegate");
    expect(delegate?.inputSchema.properties["repo"]).toMatchObject({ type: "string" });
    expect(delegate?.description).toContain("linked repositories");
  });

  it("reports a tool error instead of throwing when an argument is missing", async () => {
    const client = await connect(new FakeBackend());
    const result = await client.callTool({ name: "tide_experts_send_message", arguments: { to: "api" } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("`text` is required");
    await client.close();
  });

  it("says so when the thread is not on a panel", async () => {
    const backend = new FakeBackend();
    backend.session = undefined;
    const client = await connect(backend);
    const result = await client.callTool({ name: "tide_experts_post_finding", arguments: { text: "x" } });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("not part of an expert panel");
    await client.close();
  });
});

describe("thread tools", () => {
  const call = async (b: FakeBackend, name: string, args: Record<string, unknown>) => {
    const client = await connect(b);
    const r = await client.callTool({ name, arguments: args });
    return { text: firstText(r), isError: (r as { isError?: boolean }).isError === true };
  };

  it("lists threads as a table", async () => {
    const b = new FakeBackend();
    const r = await call(b, "tide_thread_list", { includeDelegates: true, limit: 5 });
    expect(r.text).toContain("id | title | provider | status | attention | role");
    expect(r.text).toContain("t1 | Fix bug | claude | running | question | review");
    expect(b.threadCalls[0]).toEqual(["list", { includeDelegates: true, limit: 5 }]);
  });

  it("reads a timeline with truncation and nextPosition", async () => {
    const b = new FakeBackend();
    const r = await call(b, "tide_thread_read", { threadId: "t1", view: "activity", afterPosition: 3 });
    expect(r.text).toContain("[assistant; turn=u1; pos=4] (item truncated) hello");
    expect(r.text).toContain("afterPosition=5");
    expect(b.threadCalls[0]).toEqual(["read", { threadId: "t1", view: "activity", afterPosition: 3 }]);
  });

  it("sends with clientRequestId forwarded as commandId", async () => {
    const b = new FakeBackend();
    const r = await call(b, "tide_thread_send", { threadId: "t1", text: "go", mode: "queue", clientRequestId: "req-1" });
    expect(r.text).toContain("queued");
    expect(b.threadCalls[0]).toEqual(["send", { threadId: "t1", text: "go", mode: "queue", commandId: "req-1" }]);
  });

  it("waits and reports the result", async () => {
    const b = new FakeBackend();
    const r = await call(b, "tide_thread_wait", { threadId: "t1", timeoutMs: 5000 });
    expect(r.text).toContain("settled: true");
    expect(r.text).toContain("child done");
    expect(b.threadCalls[0]).toEqual(["wait", { threadId: "t1", timeoutMs: 5000 }]);
  });

  it("interrupts, lists and answers pending questions", async () => {
    const b = new FakeBackend();
    expect((await call(b, "tide_thread_interrupt", { threadId: "t1" })).text).toBe("Interrupted.");
    const list = await call(b, "tide_pending_list", { threadId: "t1" });
    expect(list.text).toContain("requestId=r1");
    expect(list.text).toContain("q1: Which? [A / B]");
    expect((await call(b, "tide_pending_respond", { threadId: "t1", requestId: "r1", answers: { q1: "A" } })).text).toBe("Answered.");
    expect(b.threadCalls.at(-1)).toEqual(["pendingRespond", { threadId: "t1", requestId: "r1", answers: { q1: "A" } }]);
    expect((await call(b, "tide_pending_respond", { threadId: "t1", requestId: "r1", answers: "A" })).isError).toBe(true);
  });

  it("maps forbidden and not-found errors", async () => {
    const b = new FakeBackend();
    b.failWith = Object.assign(new Error("ceiling"), { code: "forbidden" });
    const f = await call(b, "tide_thread_send", { threadId: "t1", text: "x" });
    expect(f.isError).toBe(true);
    expect(f.text).toContain("narrower privileges");
    b.failWith = Object.assign(new Error("gone"), { code: "not-found" });
    const n = await call(b, "tide_thread_read", { threadId: "nope" });
    expect(n.isError).toBe(true);
    expect(n.text).toContain("Not found");
  });

  it("delegate completion=wait returns the child's result", async () => {
    const b = new FakeBackend();
    const r = await call(b, "tide_delegate", { provider: "codex", prompt: "do", role: "review", clientRequestId: "d-1", completion: "wait" });
    expect(r.text).toContain("thread-child");
    expect(r.text).toContain("child done");
    expect(b.commands[0]).toMatchObject({ type: "thread.delegate", role: "review", commandId: "d-1" });
    expect(b.threadCalls[0]).toEqual(["wait", { threadId: "thread-child", timeoutMs: 600000 }]);
  });

  it("delegate wait timeout reports waitTimedOut and keeps the child running", async () => {
    const b = new FakeBackend();
    b.waitResult = { status: "running", settled: false, timedOut: true };
    const r = await call(b, "tide_delegate", { provider: "claude", prompt: "do", completion: "wait", timeoutMs: 1000 });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('"waitTimedOut":true');
    expect(r.text).toContain("keeps running");
    expect(b.threadCalls[0]).toEqual(["wait", { threadId: "thread-child", timeoutMs: 1000 }]);
  });

  it("delegate async does not wait", async () => {
    const b = new FakeBackend();
    await call(b, "tide_delegate", { provider: "claude", prompt: "do" });
    expect(b.threadCalls).toEqual([]);
  });

  it("exports the hint and lists all thread tools", () => {
    expect(THREAD_TOOLS_HINT).toContain("cannot approve");
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toContain("tide_pending_respond");
  });
});

describe("automation tools", () => {
  const call = async (b: FakeBackend, name: string, args: Record<string, unknown>) => {
    const client = await connect(b);
    const r = await client.callTool({ name, arguments: args });
    return { text: firstText(r), isError: (r as { isError?: boolean }).isError === true };
  };

  it("converts minutes to ms and forwards clientRequestId as commandId", async () => {
    const b = new FakeBackend();
    const r = await call(b, "tide_schedule_task", {
      title: "Sweep",
      prompt: "tidy",
      schedule: { kind: "interval", everyMinutes: 15 },
      provider: "codex",
      useWorktree: false,
      clientRequestId: "req-9",
    });
    expect(r.isError).toBe(false);
    expect(b.commands[0]).toMatchObject({
      type: "task.create",
      title: "Sweep",
      prompt: "tidy",
      schedule: { kind: "interval", everyMs: 900_000 },
      provider: "codex",
      useWorktree: false,
      commandId: "req-9",
    });
  });

  it("creates fixed schedules and rejects bad ones", async () => {
    const b = new FakeBackend();
    await call(b, "tide_schedule_task", { title: "t", prompt: "p", threadId: "t1", schedule: { kind: "fixed", times: ["09:00"], weekdays: [1, 2] } });
    expect(b.commands[0]).toMatchObject({ schedule: { kind: "fixed", times: ["09:00"], weekdays: [1, 2] }, threadId: "t1" });
    const bad = await call(b, "tide_schedule_task", { title: "t", prompt: "p", schedule: { kind: "fixed", times: ["9am"], weekdays: [1] } });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("HH:MM");
    const tooFast = await call(b, "tide_schedule_task", { title: "t", prompt: "p", schedule: { kind: "interval", everyMinutes: 0 } });
    expect(tooFast.isError).toBe(true);
    expect(b.commands).toHaveLength(1);
  });

  it("updates, deletes and runs now", async () => {
    const b = new FakeBackend();
    await call(b, "tide_update_scheduled_task", { taskId: "k1", enabled: false, schedule: { kind: "interval", everyMinutes: 60 } });
    await call(b, "tide_delete_scheduled_task", { taskId: "k1" });
    await call(b, "tide_run_scheduled_task_now", { taskId: "k1" });
    expect(b.commands).toEqual([
      { type: "task.update", taskId: "k1", enabled: false, schedule: { kind: "interval", everyMs: 3_600_000 } },
      { type: "task.delete", taskId: "k1" },
      { type: "task.run-now", taskId: "k1" },
    ]);
  });

  it("the hint mentions automations", () => {
    expect(THREAD_TOOLS_HINT).toContain("tide_schedule_task");
  });
});


describe("tide_list_scheduled_tasks (R4)", () => {
  it("lists the project's automations from agent.task.list", async () => {
    const backend = new FakeBackend();
    const client = await connect(backend);
    const result = await client.callTool({ name: "tide_list_scheduled_tasks", arguments: {} });
    expect(backend.threadCalls.map(([name]) => name)).toContain("taskList");
    expect(firstText(result)).toContain("task-1 | Nightly lint | every 60 min | new thread | enabled | runs=2");
  });
});
