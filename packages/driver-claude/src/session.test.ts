import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv, NormalizedEvent, OpenSessionOptions } from "@tide/contracts";
import { EXIT_PLAN_DENY_MESSAGE } from "./approvals.ts";
import { AsyncQueue } from "./async-queue.ts";
import type { PermissionResultShape } from "./approvals.ts";
import type { ClaudeMessage } from "./sdk-shapes.ts";
import { ClaudeSession } from "./session.ts";
import type { QueryFn } from "./types.ts";

type CanUseTool = (toolName: string, input: Record<string, unknown>, context: { toolUseID: string; signal?: AbortSignal; title?: string }) => Promise<PermissionResultShape>;

class MockQuery {
  readonly messages = new AsyncQueue<ClaudeMessage>();
  interrupts = 0;
  contextUsage: { totalTokens: number; rawMaxTokens: number } | undefined;
  readonly options: Record<string, unknown>;
  constructor(options: Record<string, unknown>) {
    this.options = options;
  }
  async *[Symbol.asyncIterator](): AsyncGenerator<ClaudeMessage, void> {
    yield* this.messages.drain();
  }
  async interrupt(): Promise<void> {
    this.interrupts++;
  }
  async getContextUsage(): Promise<{ totalTokens: number; rawMaxTokens: number }> {
    if (!this.contextUsage) throw new Error("no context usage");
    return this.contextUsage;
  }
  canUseTool(toolName: string, input: Record<string, unknown>, toolUseID: string, extra: { signal?: AbortSignal; title?: string } = {}): Promise<PermissionResultShape> {
    const callback = this.options["canUseTool"] as CanUseTool;
    return callback(toolName, input, { toolUseID, ...extra });
  }
  init(sessionId = "session-1"): void {
    this.messages.push({ type: "system", subtype: "init", session_id: sessionId, model: "claude-sonnet-5" } as ClaudeMessage);
  }
  result(): void {
    this.messages.push({ type: "result", subtype: "success", session_id: "session-1", is_error: false, usage: { input_tokens: 5, output_tokens: 7 }, total_cost_usd: 0.01 } as ClaudeMessage);
  }
}

function harness(overrides: Partial<OpenSessionOptions> = {}): { session: ClaudeSession; query: () => MockQuery; logs: string[] } {
  const logs: string[] = [];
  const env: DriverEnv = { dataDir: tmpdir(), log: (msg) => logs.push(msg) };
  let created: MockQuery | undefined;
  const queryFn: QueryFn = ({ options }) => {
    created = new MockQuery(options ?? {});
    return created as unknown as ReturnType<QueryFn>;
  };
  const options: OpenSessionOptions = {
    threadId: "t1",
    cwd: tmpdir(),
    mode: "approval-required",
    interaction: "default",
    mcpServers: [],
    ...overrides,
  };
  return { session: new ClaudeSession({}, env, options, queryFn), query: () => created!, logs, };
}

async function collect(stream: AsyncIterable<NormalizedEvent>, sink: NormalizedEvent[]): Promise<void> {
  for await (const event of stream) sink.push(event);
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("ClaudeSession", () => {
  it("maps Tide options onto the SDK's, without crippling the harness", async () => {
    const { session, query } = harness({
      mode: "full-access",
      model: "opus",
      systemPromptAppend: "be terse",
      mcpServers: [{ name: "tide", command: "node", args: ["mcp.js"], env: { A: "1" } }],
      env: { TIDE_THREAD: "t1" },
    });
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "hi" }), events);
    await tick();
    const options = query().options;
    expect(options["permissionMode"]).toBe("bypassPermissions");
    expect(options["allowDangerouslySkipPermissions"]).toBe(true);
    expect(options["includePartialMessages"]).toBe(true);
    expect(options["model"]).toBe("opus");
    expect(options["systemPrompt"]).toEqual({ type: "preset", preset: "claude_code", append: "be terse" });
    expect(options["mcpServers"]).toEqual({ tide: { type: "stdio", command: "node", args: ["mcp.js"], env: { A: "1" } } });
    expect((options["env"] as Record<string, string>)["TIDE_THREAD"]).toBe("t1");
    // never narrow the user's own configuration
    expect(options).not.toHaveProperty("settingSources");
    expect(options).not.toHaveProperty("strictMcpConfig");
    query().init();
    query().result();
    await done;
    expect(session.nativeSessionId).toBe("session-1");
  });

  it("uses the claude_code preset system prompt even when nothing is appended", async () => {
    // An omitted `systemPrompt` means "empty custom prompt" to the SDK, which would strip the
    // Claude Code system prompt entirely (CLAUDE.md §1a: never cripple the harness).
    const { session, query } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "hi" }), events);
    await tick();
    expect(query().options["systemPrompt"]).toEqual({ type: "preset", preset: "claude_code" });
    query().init();
    query().result();
    await done;
  });

  it("maps plan interaction to plan mode regardless of runtime mode", async () => {
    const { session, query } = harness({ mode: "full-access", interaction: "plan" });
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "plan it" }), events);
    await tick();
    expect(query().options["permissionMode"]).toBe("plan");
    query().init();
    query().result();
    await done;
  });

  it("round-trips an approval, with a diff for edits, and applies the session rule", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-diff-"));
    const file = join(dir, "a.txt");
    writeFileSync(file, "one\ntwo\nthree\n");

    const { session, query } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "edit it" }), events);
    await tick();
    query().init();
    const decision = query().canUseTool("Edit", { file_path: file, old_string: "two", new_string: "2" }, "toolu_1", { title: "Claude wants to edit a.txt" });
    await tick();

    const approval = events.find((event) => event.type === "activity" && event.activity.kind === "approval");
    if (approval?.type !== "activity" || approval.activity.kind !== "approval") throw new Error("no approval activity");
    expect(approval.activity.requestId).toBe("toolu_1");
    expect(approval.activity.toolName).toBe("Edit");
    expect(approval.activity.title).toBe("Claude wants to edit a.txt");
    expect(approval.activity.diff).toContain("-two");
    expect(approval.activity.diff).toContain("+2");

    await session.respondApproval("toolu_1", "acceptForSession");
    expect(await decision).toEqual({
      behavior: "allow",
      updatedInput: { file_path: file, old_string: "two", new_string: "2" },
      updatedPermissions: [{ type: "addRules", rules: [{ toolName: "Edit" }], behavior: "allow", destination: "session" }],
    });

    query().contextUsage = { totalTokens: 1200, rawMaxTokens: 200000 };
    query().result();
    await done;
    expect(events.filter((event) => event.type === "usage")).toEqual([
      { type: "usage", usage: { inputTokens: 5, outputTokens: 7, costUsd: 0.01 } },
      { type: "usage", contextUsage: { used: 1200, window: 200000 } },
    ]);
  });

  it("declines and cancels", async () => {
    for (const [decision, expected] of [
      ["decline", { behavior: "deny", message: "Declined by user in Tide" }],
      ["cancel", { behavior: "deny", message: "Declined by user in Tide", interrupt: true }],
    ] as const) {
      const { session, query } = harness();
      const events: NormalizedEvent[] = [];
      const done = collect(session.send({ text: "go" }), events);
      await tick();
      query().init();
      const result = query().canUseTool("Bash", { command: "rm -rf /" }, "toolu_x");
      await tick();
      await session.respondApproval("toolu_x", decision);
      expect(await result).toEqual(expected);
      query().result();
      await done;
    }
  });

  it("denies when the SDK aborts the permission request", async () => {
    const { session, query } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "go" }), events);
    await tick();
    query().init();
    const controller = new AbortController();
    const result = query().canUseTool("Bash", { command: "ls" }, "toolu_a", { signal: controller.signal });
    await tick();
    controller.abort();
    expect(await result).toEqual({ behavior: "deny", message: "Declined by user in Tide" });
    query().result();
    await done;
  });

  it("round-trips AskUserQuestion into the tool's own answers field", async () => {
    const { session, query } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "ask me" }), events);
    await tick();
    query().init();
    const input = {
      questions: [
        {
          question: "Which language?",
          header: "Language",
          multiSelect: false,
          options: [
            { label: "TypeScript", description: "typed" },
            { label: "JavaScript", description: "untyped" },
          ],
        },
      ],
    };
    const result = query().canUseTool("AskUserQuestion", input, "toolu_q");
    await tick();

    const activity = events.find((event) => event.type === "activity" && event.activity.kind === "user-input");
    if (activity?.type !== "activity" || activity.activity.kind !== "user-input") throw new Error("no user-input activity");
    expect(activity.activity.requestId).toBe("toolu_q");
    expect(activity.activity.questions).toEqual([
      {
        id: "q0",
        text: "Which language?",
        options: [
          { label: "TypeScript", description: "typed" },
          { label: "JavaScript", description: "untyped" },
        ],
      },
    ]);

    await session.respondUserInput("toolu_q", { q0: "TypeScript" });
    expect(await result).toEqual({ behavior: "allow", updatedInput: { ...input, answers: { "Which language?": "TypeScript" } } });
    query().result();
    await done;
  });

  it("captures ExitPlanMode as a proposed plan and refuses to let the harness start building", async () => {
    const { session, query } = harness({ interaction: "plan" });
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "plan it" }), events);
    await tick();
    query().init();
    const result = await query().canUseTool("ExitPlanMode", { plan: "# Plan\n1. do it" }, "toolu_plan");
    expect(result).toEqual({ behavior: "deny", message: EXIT_PLAN_DENY_MESSAGE });
    query().result();
    await done;
    expect(events).toContainEqual({ type: "plan.proposed", markdown: "# Plan\n1. do it" });
  });

  it("settles as interrupted after interrupt()", async () => {
    const { session, query } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "long job" }), events);
    await tick();
    query().init();
    await session.interrupt();
    expect(query().interrupts).toBe(1);
    query().result();
    await done;
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
  });

  it("runs consecutive turns on one streaming-input query", async () => {
    const { session, query } = harness();
    const first: NormalizedEvent[] = [];
    const done1 = collect(session.send({ text: "one" }), first);
    await tick();
    const q = query();
    q.init();
    q.result();
    await done1;

    const second: NormalizedEvent[] = [];
    const done2 = collect(session.send({ text: "two" }), second);
    await tick();
    expect(query()).toBe(q); // no second CLI process
    q.result();
    await done2;
    expect(second.at(-1)).toEqual({ type: "settled", status: "completed" });
    expect(first.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("refuses a second concurrent turn", async () => {
    const { session, query } = harness();
    const events: NormalizedEvent[] = [];
    const done = collect(session.send({ text: "one" }), events);
    await tick();
    expect(() => session.send({ text: "two" })).toThrow(/busy/);
    query().init();
    query().result();
    await done;
    await session.close();
    expect(() => session.send({ text: "three" })).toThrow(/closed/);
  });
});
