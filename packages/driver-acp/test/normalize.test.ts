import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "@tide/contracts";
import { AcpNormalizer, toSlashCommands, toolOutput } from "../src/normalize.ts";
import type { AcpSessionUpdate } from "../src/types.ts";
import { loadFixture } from "./fake-agent.ts";

/** Feeds every `session/update` the AGENT sent in a fixture through one normalizer turn. */
function run(name: string, normalizer = new AcpNormalizer()): NormalizedEvent[] {
  normalizer.beginTurn();
  const events: NormalizedEvent[] = [];
  for (const line of loadFixture(name)) {
    if (line._dir === "c2a" || line.method !== "session/update") continue;
    const update = (line.params as { update: AcpSessionUpdate }).update;
    events.push(...normalizer.next(update));
  }
  return events;
}

function kinds(events: NormalizedEvent[]): string[] {
  return events.map((event) => (event.type === "activity" ? `activity:${event.activity.kind}` : event.type));
}

function activities(events: NormalizedEvent[]) {
  return events.flatMap((event) => (event.type === "activity" ? [event.activity] : []));
}

describe("normalizer over fixtures", () => {
  it("simple-turn: reasoning and answer share a message key; usage_update becomes context usage", () => {
    const events = run("synthetic/simple-turn");
    expect(kinds(events)).toEqual(["assistant.reasoning", "assistant.delta", "assistant.delta", "usage"]);
    const keys = events.flatMap((event) => (event.type === "assistant.delta" || event.type === "assistant.reasoning" ? [event.messageKey] : []));
    expect(new Set(keys).size).toBe(1);
    expect(events.at(-1)).toEqual({ type: "usage", contextUsage: { used: 1200, window: 200000 } });
  });

  it("tool-permission-accept: tool_call + updates merge into one tool activity by toolCallId", () => {
    const events = run("synthetic/tool-permission-accept");
    expect(kinds(events)).toEqual(["activity:tool", "activity:tool", "activity:tool", "assistant.delta"]);
    const tools = activities(events);
    expect(tools.map((tool) => (tool.kind === "tool" ? [tool.toolUseId, tool.status] : []))).toEqual([
      ["call_1", "running"],
      ["call_1", "running"],
      ["call_1", "ok"],
    ]);
    const first = tools[0];
    if (first?.kind !== "tool") throw new Error("unreachable");
    expect(first.toolName).toBe("Edit hello.txt");
    expect(first.input).toEqual({ path: "/repo/hello.txt", old: "hello", new: "hi" });
    expect(first.output).toContain("-hello");
    // `content` replaces: the final output is the text block, not the diff
    const last = tools[2];
    if (last?.kind !== "tool") throw new Error("unreachable");
    expect(last.output).toBe("Edited hello.txt");
    expect(last.input).toEqual(first.input);
  });

  it("text after a tool call starts a new assistant message", () => {
    const normalizer = new AcpNormalizer();
    normalizer.beginTurn();
    const a = normalizer.next({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before" } });
    normalizer.next({ sessionUpdate: "tool_call", toolCallId: "t", title: "ls", kind: "execute", status: "pending" });
    const b = normalizer.next({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after" } });
    const key = (events: NormalizedEvent[]) => (events[0]?.type === "assistant.delta" ? events[0].messageKey : undefined);
    expect(key(a)).not.toBe(key(b));
    expect(normalizer.lastText()).toBe("after");
  });

  it("permission-declined: failed tool update maps to status error", () => {
    const tools = activities(run("synthetic/permission-declined"));
    expect(tools.at(-1)).toMatchObject({ kind: "tool", toolUseId: "call_x", status: "error", output: "User rejected", input: { command: "rm -rf build" } });
  });

  it("plan-entries: each plan update is a full plan.progress replace", () => {
    const events = run("synthetic/plan-entries");
    expect(kinds(events)).toEqual(["plan.progress", "plan.progress", "assistant.delta"]);
    expect(events[1]).toEqual({
      type: "plan.progress",
      steps: [
        { text: "Read code", status: "completed" },
        { text: "Write tests", status: "in_progress" },
        { text: "Ship", status: "pending" },
      ],
    });
  });

  it("commands-update: available commands become a custom command list; mode change is an info row", () => {
    const seen: string[] = [];
    const modes: string[] = [];
    const events = run("synthetic/commands-update", new AcpNormalizer({ onCommands: (list) => seen.push(...list.map((c) => c.name)), onModeChange: (id) => modes.push(id) }));
    expect(kinds(events)).toEqual(["commands", "activity:info"]);
    expect(events[0]).toEqual({
      type: "commands",
      commands: [
        { name: "web", description: "Search the web", argumentHint: "query to search for", source: "custom" },
        { name: "init", description: "create AGENTS.md", source: "custom" },
      ],
    });
    expect(seen).toEqual(["web", "init"]);
    expect(modes).toEqual(["plan"]);
  });

  it("unknown-update: unmodelled variants pass through with the raw payload; config_option_update is silent", () => {
    const events = run("synthetic/unknown-update");
    expect(kinds(events)).toEqual(["activity:info"]);
    expect(activities(events)[0]).toMatchObject({ kind: "info", text: "_vendor_progress", payload: { percent: 40, label: "indexing" } });
  });

  it("load-replay: a muted normalizer emits nothing but still tracks commands", () => {
    const normalizer = new AcpNormalizer({ onCommands: (list) => expect(list.map((c) => c.name)).toEqual(["compact"]) });
    normalizer.muted = true;
    expect(run("synthetic/load-replay", normalizer)).toEqual([]);
  });

  it("opencode 1.1 init (recorded): no updates outside the prompt", () => {
    expect(run("opencode-acp-1.1/init")).toEqual([]);
  });

  it("opencode 1.1 cancel-turn (recorded): OpenCode sends its command list during the turn", () => {
    const events = run("opencode-acp-1.1/cancel-turn");
    expect(kinds(events)).toEqual(["commands"]);
    if (events[0]?.type !== "commands") throw new Error("unreachable");
    expect(events[0].commands.map((command) => command.name)).toEqual(["init", "review", "compact"]);
  });
});

describe("helpers", () => {
  it("toolOutput renders diffs, text, terminals and falls back to rawOutput", () => {
    expect(toolOutput({ toolCallId: "a", content: [{ type: "terminal", terminalId: "t1" }] })).toBe("[terminal t1]");
    expect(toolOutput({ toolCallId: "a", rawOutput: { exit: 0 } })).toContain('"exit": 0');
    expect(toolOutput({ toolCallId: "a" })).toBeUndefined();
    expect(toolOutput({ toolCallId: "a", content: [{ type: "diff", path: "/r/x", newText: "new\n" }] })).toContain("+new");
  });

  it("toSlashCommands drops nameless entries and tolerates junk", () => {
    expect(toSlashCommands("nope")).toEqual([]);
    expect(toSlashCommands([{ name: "a", input: null }, { description: "x" }])).toEqual([{ name: "a", source: "custom" }]);
  });

  it("a tool without rawInput reports title/kind/locations as input", () => {
    const normalizer = new AcpNormalizer();
    normalizer.beginTurn();
    const [event] = normalizer.next({ sessionUpdate: "tool_call", toolCallId: "r", title: "Read a.ts", kind: "read", status: "in_progress", locations: [{ path: "/r/a.ts" }] });
    expect(event).toMatchObject({ activity: { toolName: "Read a.ts", input: { title: "Read a.ts", kind: "read", locations: [{ path: "/r/a.ts" }] } } });
  });
});
