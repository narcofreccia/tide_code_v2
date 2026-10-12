import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { PI_SILENT_EVENTS, PiNormalizer, displayToolName } from "../src/index.ts";
import type { PiEvent } from "../src/types.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "pi");

/** Real pi 1.1.0 records (see record-fixtures.ts); dialogs and responses are the session's job. */
function run(name: string): { events: NormalizedEvent[]; unknown: number } {
  const normalizer = new PiNormalizer();
  const events: NormalizedEvent[] = [];
  for (const line of readFileSync(join(fixtures, `${name}.ndjson`), "utf8").split("\n").filter((line) => line.trim() !== "")) {
    const record = JSON.parse(line) as PiEvent;
    if (record.type === "extension_ui_request" || record.type === "response") continue;
    events.push(...normalizer.next(record));
  }
  return { events, unknown: normalizer.unknownCount };
}

function kinds(events: NormalizedEvent[]): string[] {
  return events.map((event) => (event.type === "activity" ? `activity:${event.activity.kind}` : event.type));
}

const tools = (events: NormalizedEvent[]) => events.flatMap((event) => (event.type === "activity" && event.activity.kind === "tool" ? [event.activity] : []));

describe("normalizer over real pi 1.1.0 recordings", () => {
  it("basic-turn: reasoning, then text, then settled — and nothing unmodelled", () => {
    const { events, unknown } = run("basic-turn");
    expect(kinds(events)).toEqual(["assistant.reasoning", "assistant.delta", "assistant.delta", "settled"]);
    expect(unknown).toBe(0);
    const text = events.flatMap((event) => (event.type === "assistant.delta" ? [event.delta] : [])).join("");
    expect(text).toBe("Hello from pi.");
    const keys = new Set(events.flatMap((event) => (event.type === "assistant.delta" || event.type === "assistant.reasoning" ? [event.messageKey] : [])));
    expect(keys.size).toBe(1);
    expect(events.at(-1)).toEqual({ type: "settled", status: "completed" });
  });

  it("tool-call: pairs start/end, keeps the input on the end frame (which has no args), and carries durationMs", () => {
    const { events, unknown } = run("tool-call");
    expect(unknown).toBe(0);
    const [running, done] = tools(events);
    expect(running).toMatchObject({ toolUseId: "call_1_0", toolName: "bash", status: "running", input: { command: "ls" } });
    expect(done).toMatchObject({ toolUseId: "call_1_0", toolName: "bash", status: "ok", input: { command: "ls" } });
    expect(typeof done?.durationMs).toBe("number");
    // the two assistant messages stay apart
    const keys = events.flatMap((event) => (event.type === "assistant.delta" ? [event.messageKey] : []));
    expect(new Set(keys).size).toBe(2);
  });

  it("plan: the plan-mode block surfaces as a failed tool, the plan tool as a normal one", () => {
    const list = tools(run("plan").events);
    expect(list.find((tool) => tool.status === "error")).toMatchObject({ toolName: "bash", output: expect.stringContaining("Plan mode") });
    expect(list.filter((tool) => tool.toolName === "tide_propose_plan").map((tool) => tool.status)).toEqual(["running", "ok"]);
  });

  it("mcp: an MCP tool is shown as server/tool", () => {
    const list = tools(run("mcp").events);
    expect(list.map((tool) => tool.toolName)).toEqual(["echo/echo", "echo/echo"]);
    expect(list[1]).toMatchObject({ status: "ok", output: "echo: ping", input: { text: "ping" } });
  });

  it("error-turn: settles with the provider's error message", () => {
    const { events } = run("error-turn");
    expect(kinds(events)).toEqual(["settled"]);
    expect(events[0]).toMatchObject({ type: "settled", status: "error", error: expect.stringContaining("mock: this model refuses") });
  });

  it("aborted: `agent_settled.aborted` (1.1) wins over the trailing stopReason:error message", () => {
    const { events } = run("aborted");
    // pi ends the aborted run with an assistant message whose stopReason is "error"
    expect(events.at(-1)).toEqual({ type: "settled", status: "interrupted" });
  });
});

describe("normalizer details", () => {
  it("interleaves reasoning and text of one message under one key, and keeps messages apart", () => {
    const normalizer = new PiNormalizer();
    const thinking = (delta: string, contentIndex: number): PiEvent => ({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex, delta } });
    const text = (delta: string, contentIndex: number): PiEvent => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex, delta } });
    normalizer.next({ type: "message_start" });
    const first = [...normalizer.next(thinking("plan", 0)), ...normalizer.next(text("hi", 1)), ...normalizer.next(thinking("more", 2))];
    normalizer.next({ type: "message_start" });
    const second = normalizer.next(text("bye", 0));
    expect(first.map((event) => event.type)).toEqual(["assistant.reasoning", "assistant.delta", "assistant.reasoning"]);
    expect(new Set(first.map((event) => (event.type === "assistant.delta" || event.type === "assistant.reasoning" ? event.messageKey : "")))).toEqual(new Set(["pi-1"]));
    expect(second[0]).toEqual({ type: "assistant.delta", messageKey: "pi-2", delta: "bye" });
  });

  it("passes unknown events through as an info activity carrying the raw frame", () => {
    const normalizer = new PiNormalizer();
    expect(normalizer.next({ type: "brand_new", foo: 1 })).toEqual([{ type: "activity", activity: { kind: "info", text: "pi: brand_new", payload: { type: "brand_new", foo: 1 } } }]);
    expect(normalizer.unknownCount).toBe(1);
  });

  it("truncates an oversized payload to a JSON string", () => {
    const normalizer = new PiNormalizer();
    const [event] = normalizer.next({ type: "huge", blob: "x".repeat(9000) });
    const payload = event?.type === "activity" && event.activity.kind === "info" ? event.activity.payload : undefined;
    expect(typeof payload).toBe("string");
    expect(payload as string).toMatch(/more characters\)$/);
    expect((payload as string).length).toBeLessThan(4200);
  });

  it("drops only the content-free housekeeping frames", () => {
    expect([...PI_SILENT_EVENTS]).toEqual(["agent_start", "agent_end", "turn_start", "turn_end", "queue_update", "tool_execution_update", "bash_execution_update"]);
    const normalizer = new PiNormalizer();
    for (const type of PI_SILENT_EVENTS) expect(normalizer.next({ type })).toEqual([]);
    expect(normalizer.unknownCount).toBe(0);
  });

  it("surfaces extension errors, failed retries and failed compaction", () => {
    const normalizer = new PiNormalizer();
    expect(normalizer.next({ type: "extension_error", extensionPath: "/x.ts", event: "tool_call", error: "boom" })[0]).toMatchObject({ activity: { kind: "error", text: "Extension error (tool_call): boom" } });
    expect(normalizer.next({ type: "auto_retry_end", success: true, attempt: 2 })).toEqual([]);
    expect(normalizer.next({ type: "auto_retry_end", success: false, attempt: 3, finalError: "529" })[0]).toMatchObject({ activity: { kind: "error" } });
    expect(normalizer.next({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false, errorMessage: "no model" })[0]).toMatchObject({ activity: { kind: "error", text: "Compaction failed: no model" } });
    expect(normalizer.next({ type: "compaction_end", reason: "threshold", result: {}, aborted: false })[0]).toMatchObject({ activity: { kind: "info", text: "Context compacted" } });
  });

  it("points at the full log when bash output was truncated (0.99 structuredContent)", () => {
    const normalizer = new PiNormalizer();
    normalizer.next({ type: "tool_execution_start", toolCallId: "c", toolName: "bash", args: { command: "yes" } });
    const [end] = normalizer.next({
      type: "tool_execution_end",
      toolCallId: "c",
      toolName: "bash",
      result: { content: [{ type: "text", text: "y\ny" }], structuredContent: { output: "y", truncated: true, full_output_path: "/tmp/pi-bash-1.log" } },
      isError: false,
      durationMs: 12,
    });
    expect(end).toMatchObject({ activity: { output: "y\ny\n(full output: /tmp/pi-bash-1.log)", durationMs: 12, input: { command: "yes" } } });
  });

  it("names built-ins without the builtin: prefix and MCP tools as server/tool", () => {
    expect(displayToolName("builtin:read")).toBe("read");
    expect(displayToolName("mcp__tide__board_post")).toBe("tide/board_post");
    expect(displayToolName("mcp__my_server__get_x")).toBe("my_server/get_x");
    expect(displayToolName("bash")).toBe("bash");
  });

  it("settles as interrupted once marked, or when pi says the run was aborted", () => {
    const marked = new PiNormalizer();
    marked.markInterrupted();
    expect(marked.next({ type: "agent_settled", aborted: false })).toEqual([{ type: "settled", status: "interrupted" }]);
    const external = new PiNormalizer();
    external.next({ type: "message_end", message: { role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" } });
    expect(external.next({ type: "agent_settled", aborted: true })).toEqual([{ type: "settled", status: "interrupted" }]);
  });

  it("beginTurn clears the previous turn's stop reason and abort flag", () => {
    const normalizer = new PiNormalizer();
    normalizer.next({ type: "message_end", message: { role: "assistant", stopReason: "aborted" } });
    expect(normalizer.next({ type: "agent_settled", aborted: true })).toEqual([{ type: "settled", status: "interrupted" }]);
    normalizer.beginTurn();
    expect(normalizer.next({ type: "agent_settled", aborted: false })).toEqual([{ type: "settled", status: "completed" }]);
  });
});
