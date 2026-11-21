import { describe, expect, it } from "vitest";
import type { AgentCommand } from "@tide/contracts";
import type { AgentBackend, AgentDispatchResult, HarnessesResult, ThreadWaitInput, ThreadWaitResult } from "./backend.ts";
import { BoardState, callTool } from "./server.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";

// R23: tide_harnesses lists what tide_delegate can reach; delegate/schedule results carry the server's model note.

const HARNESSES: HarnessesResult = {
  harnesses: [
    { provider: "claude", providerId: "claude", label: "Claude Code", installed: true, loggedIn: true, defaultModel: "opus", models: [{ id: "opus", label: "Opus 5.5" }, { id: "sonnet", label: "Sonnet 5.5" }] },
    { provider: "codex", providerId: "codex", label: "Codex", installed: true, loggedIn: false, models: [] },
  ],
};

class NoteBackend {
  readonly refreshes: (boolean | undefined)[] = [];
  modelNote: string | undefined = "model `opus-5.5` is not an id claude lists; using `opus` (Opus 5.5)";

  async dispatch(command: AgentCommand): Promise<AgentDispatchResult> {
    const note = this.modelNote !== undefined ? { modelNote: this.modelNote } : {};
    if (command.type === "task.create") {
      const task = { id: "task-1", projectId: "p", title: "t", prompt: "p", schedule: { kind: "interval" as const, everyMs: 60_000 }, enabled: true, runs: 0, createdAt: 1, updatedAt: 1 };
      return { seq: 1, events: [{ seq: 1, ts: 1, event: { type: "task.created", task } }], ...note };
    }
    const thread = { id: "child", projectId: "p", title: "d", provider: "claude" as const, mode: "auto" as const, interaction: "default" as const, status: "idle" as const, createdAt: 1, updatedAt: 1 };
    return { seq: 1, events: [{ seq: 1, ts: 1, event: { type: "thread.created", thread } }], ...note };
  }

  async threadWait(_input: ThreadWaitInput): Promise<ThreadWaitResult> {
    return { status: "idle", settled: true, timedOut: false, lastAssistantText: "done" };
  }

  async harnesses(refresh?: boolean): Promise<HarnessesResult> {
    this.refreshes.push(refresh);
    return HARNESSES;
  }
}

async function call(b: NoteBackend, name: string, args: Record<string, unknown>): Promise<string> {
  const backend = b as unknown as AgentBackend;
  const result = await callTool(backend, new BoardState(backend), name, args);
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

describe("tide_harnesses (R23)", () => {
  it("has a definition small enough for every harness to keep it", () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === "tide_harnesses");
    expect(def?.inputSchema.required).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(def), "utf8")).toBeLessThan(1_280);
    expect(def?.description.split(". ").length).toBeLessThanOrEqual(2);
  });

  it("returns the harnesses as compact JSON and passes refresh through", async () => {
    const b = new NoteBackend();
    expect(await call(b, "tide_harnesses", {})).toBe(JSON.stringify(HARNESSES.harnesses));
    await call(b, "tide_harnesses", { refresh: true });
    expect(b.refreshes).toEqual([false, true]);
  });

  it("tide_delegate's model param points at tide_harnesses", () => {
    const model = TOOL_DEFINITIONS.find((t) => t.name === "tide_delegate")?.inputSchema.properties["model"];
    expect(model).toEqual({ type: "string", description: "Optional model id for that harness, exactly as tide_harnesses lists it." });
  });
});

describe("model notes on delegate and schedule results (R23)", () => {
  it("tide_delegate shows the note as one line after the threadId, async and wait", async () => {
    const b = new NoteBackend();
    const lines = (await call(b, "tide_delegate", { provider: "claude", prompt: "go", model: "opus-5.5" })).split("\n");
    expect(lines[0]).toBe('{"threadId":"child"}');
    expect(lines[1]).toBe("Note: model `opus-5.5` is not an id claude lists; using `opus` (Opus 5.5)");
    expect(lines[2]).toContain("The task is running.");
    const waited = (await call(b, "tide_delegate", { provider: "claude", prompt: "go", model: "opus-5.5", completion: "wait" })).split("\n");
    expect(waited[1]).toBe("Note: model `opus-5.5` is not an id claude lists; using `opus` (Opus 5.5)");
  });

  it("tide_delegate has no note line without one", async () => {
    const b = new NoteBackend();
    b.modelNote = undefined;
    const text = await call(b, "tide_delegate", { provider: "claude", prompt: "go" });
    expect(text).not.toContain("Note:");
    expect(text.split("\n")).toHaveLength(2);
  });

  it("tide_schedule_task shows the note too", async () => {
    const b = new NoteBackend();
    b.modelNote = "model `gpt-6.2` is not in codex's list (gpt-6.2-sol); passed as is. If the delegate fails on its model, use a listed id";
    const text = await call(b, "tide_schedule_task", { title: "t", prompt: "p", schedule: { kind: "interval", everyMinutes: 1 }, provider: "codex", model: "gpt-6.2" });
    expect(text).toBe(`Automation created. taskId=task-1\nNote: ${b.modelNote}`);
  });
});
