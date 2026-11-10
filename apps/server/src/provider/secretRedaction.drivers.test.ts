import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Activity, NormalizedEvent } from "@tide/contracts";
import { AcpNormalizer } from "@tide/driver-acp";
import { CodexNormalizer } from "@tide/driver-codex";
import { OpencodeNormalizer } from "@tide/driver-opencode";
import { PiNormalizer } from "@tide/driver-pi";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { ProviderReactor } from "./reactor.ts";
import { DriverRegistry } from "./registry.ts";
import { REDACTED, SECRET_MARKER, secretValuesFor } from "./secretRedaction.ts";
import { SessionDirectory } from "./sessions.ts";
import { createFakeDriver, emit } from "./testing/fakeDriver.ts";

/**
 * R19 L8: the R18 redaction proven on each non-Claude harness. Every sequence is a recorded
 * fixture of that driver (or, for Codex, which has no MCP fixture, the fixture's framing plus an
 * `mcpToolCall` item in the app-server wire shape `items.ts` reads) with the tool renamed to how
 * that harness names Tide's secret tool and the secret placed in: the tool result, a later
 * assistant text split across two chunks, and a later shell command and its output. The native
 * lines go through the driver's own normalizer; its output is what the fake driver emits.
 */

const SECRET = "ghp_very_secret_value_123";
const HEAD = SECRET.slice(0, 9);
const TAIL = SECRET.slice(9);
const RESULT = `The user provided GITHUB_TOKEN. Use it for this task only. Do not repeat it in your replies.\n${SECRET}`;
const ARGS = { name: "GITHUB_TOKEN", purpose: "push the branch" };

const require = createRequire(import.meta.url);
const fixture = (pkg: string, path: string): unknown[] =>
  readFileSync(join(dirname(require.resolve(`@tide/${pkg}`)), "..", "test", "fixtures", path), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as unknown);
type Obj = Record<string, unknown>;
const swap = <T>(value: T, from: string, to: string): T => JSON.parse(JSON.stringify(value).split(from).join(to)) as T;

/** Codex: framing of `synthetic-basic-turn.ndjson`; mcpToolCall per `driver-codex/src/items.ts` (`mcp:<server>.<tool>`). */
function codex(): NormalizedEvent[] {
  const lines = fixture("driver-codex", "synthetic-basic-turn.ndjson") as { method: string; params: Obj }[];
  const [started, turnStarted] = lines;
  const turnDone = lines.at(-1);
  if (started === undefined || turnStarted === undefined || turnDone === undefined) throw new Error("fixture");
  const threadId = (started.params["thread"] as Obj)["id"];
  const turnId = (turnStarted.params["turn"] as Obj)["id"];
  const at = { threadId, turnId };
  const mcp = (status: string, result: unknown) => ({ type: "mcpToolCall", id: "item_secret", server: "tide", tool: "tide_request_secret", status, arguments: ARGS, result, error: null, durationMs: status === "completed" ? 5 : null });
  const cmd = (status: string, out: string | null) => ({ type: "commandExecution", id: "item_cmd", pluginId: null, scriptPath: null, command: `gh auth login --with-token ${SECRET}`, cwd: "/tmp/repo", processId: null, source: "agent", status, commandActions: [], aggregatedOutput: out, exitCode: out === null ? null : 0, durationMs: out === null ? null : 3 });
  const native = [
    started,
    turnStarted,
    { method: "item/started", params: { ...at, startedAtMs: 1, item: mcp("inProgress", null) } },
    { method: "item/completed", params: { ...at, completedAtMs: 2, item: mcp("completed", { content: [{ type: "text", text: RESULT }], structuredContent: null }) } },
    { method: "item/started", params: { ...at, startedAtMs: 3, item: cmd("inProgress", null) } },
    { method: "item/commandExecution/outputDelta", params: { ...at, itemId: "item_cmd", delta: `logged in with ${SECRET}\n` } },
    { method: "item/completed", params: { ...at, completedAtMs: 4, item: cmd("completed", `logged in with ${SECRET}\n`) } },
    { method: "item/agentMessage/delta", params: { ...at, itemId: "item_msg", delta: `Used ${HEAD}` } },
    { method: "item/agentMessage/delta", params: { ...at, itemId: "item_msg", delta: `${TAIL} to log in.` } },
    { method: "item/completed", params: { ...at, completedAtMs: 5, item: { type: "agentMessage", id: "item_msg", text: `Used ${SECRET} to log in.`, phase: null, memoryCitation: null } } },
    turnDone,
  ];
  const normalizer = new CodexNormalizer();
  return native.flatMap((l) => normalizer.next(l.method, l.params));
}

/** OpenCode: `tool-permission.ndjson` (recorded opencode serve 2.0.27); MCP tools are `<server>_<tool>`, the server `tide-<threadId>` (`mcpServerName`). */
function opencode(): NormalizedEvent[] {
  const recorded = swap(fixture("driver-opencode", "tool-permission.ndjson") as { type: string; data: Obj }[], "echo hello-from-opencode", `gh auth login --with-token ${SECRET}`);
  const raw = swap(recorded, "hello-from-opencode", `logged in with ${SECRET}`)
    .filter((e) => !e.type.startsWith("permission."));
  const out: { type: string; data: Obj; created?: number }[] = [];
  for (const e of raw) {
    if (e.type === "session.tool.input.started") {
      // the secret tool call first, as the recorded shell call is shaped
      out.push({ ...e, data: { ...e.data, id: "sec-1", name: "tide-t1_tide_request_secret" } });
      out.push({ ...e, type: "session.tool.called", data: { ...e.data, id: "sec-1", input: ARGS, executed: false } });
      out.push({ ...e, type: "session.tool.success", data: { ...e.data, id: "sec-1", content: [{ type: "text", text: RESULT }], metadata: {}, executed: false } });
    }
    if (e.type === "session.text.delta") {
      const delta = String(e.data["delta"]);
      const cut = delta.indexOf(SECRET) + 9;
      out.push({ ...e, data: { ...e.data, delta: delta.slice(0, cut) } }, { ...e, data: { ...e.data, delta: delta.slice(cut) } });
      continue;
    }
    out.push(e);
  }
  const sessionId = String((raw[0] as { data: Obj }).data["sessionID"]);
  const normalizer = new OpencodeNormalizer({ sessionId, contextWindow: 200_000 });
  return out.flatMap((e) => normalizer.next(e as never));
}

/** Pi: `pi/mcp.ndjson` (an MCP tool `mcp__<server>__<tool>`), plus a bash call shaped like its tool_execution_* lines. */
function pi(): NormalizedEvent[] {
  let lines = swap(fixture("driver-pi", "pi/mcp.ndjson") as Obj[], "mcp__echo__echo", "mcp__tide__tide_request_secret");
  lines = swap(lines, "echo: ping", RESULT.replace("\n", "\\n"));
  lines = swap(lines, '"delta":"Echo"', `"delta":"Used ${HEAD}"`);
  lines = swap(lines, '"delta":"ed."', `"delta":"${TAIL} to log in."`);
  lines = swap(lines, "Echoed.", `Used ${SECRET} to log in.`);
  const out: Obj[] = [];
  for (const line of lines) {
    out.push(line);
    if (line["type"] === "message_end" && (line["message"] as Obj | undefined)?.["role"] === "toolResult") {
      out.push(
        { type: "tool_execution_start", toolCallId: "call_2", toolName: "bash", args: { command: `gh auth login --with-token ${SECRET}` } },
        { type: "tool_execution_end", toolCallId: "call_2", toolName: "bash", result: { content: [{ type: "text", text: `logged in with ${SECRET}` }] }, isError: false, durationMs: 1 },
      );
    }
  }
  const normalizer = new PiNormalizer();
  return out.flatMap((l) => normalizer.next(l as never));
}

/** ACP: `opencode-acp/tool-turn.ndjson` session updates; the read call becomes Tide's secret tool, the edit a shell call. */
function acp(): NormalizedEvent[] {
  const lines = fixture("driver-acp", "opencode-acp/tool-turn.ndjson") as Obj[];
  const updates = lines.flatMap((l) => (l["method"] === "session/update" ? [((l["params"] as Obj)["update"]) as Obj] : []));
  const out: Obj[] = [];
  for (const u of updates) {
    const id = u["toolCallId"];
    if (id === "call_5a6eef299dd64ffc95a8834b") {
      const named = { ...u, ...(u["sessionUpdate"] === "tool_call" ? { name: "tide_tide_request_secret" } : {}), title: "tide_tide_request_secret", kind: "other", rawInput: ARGS, locations: [] };
      out.push(u["status"] === "completed" ? { ...named, content: [{ type: "content", content: { type: "text", text: RESULT } }], rawOutput: { output: RESULT } } : named);
    } else if (id === "call_757897467e2443f1b7a10c5f") {
      const shell = { ...u, ...(u["sessionUpdate"] === "tool_call" ? { name: "bash" } : {}), title: "bash", kind: "execute", rawInput: { command: `gh auth login --with-token ${SECRET}` }, locations: [] };
      out.push(u["status"] === "completed" ? { ...shell, content: [{ type: "content", content: { type: "text", text: `logged in with ${SECRET}` }}], rawOutput: { output: `logged in with ${SECRET}` } } : shell);
    } else if (u["sessionUpdate"] === "agent_message_chunk") {
      const text = String(((u["content"] as Obj)["text"]));
      out.push({ ...u, content: { type: "text", text: text.startsWith("Done") ? `Used ${HEAD}` : `${TAIL} to log in.` } });
    } else out.push(u);
  }
  const normalizer = new AcpNormalizer();
  return [...out.flatMap((u) => normalizer.next(u as never)), { type: "settled", status: "completed" }];
}

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

async function replayThroughReactor(events: NormalizedEvent[]) {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const sent: unknown[] = [];
  const dispatch = engine.dispatch.bind(engine);
  engine.dispatch = (command) => {
    sent.push(command);
    return dispatch(command);
  };
  const { driver, control } = createFakeDriver("claude");
  const registry = new DriverRegistry({ env: { dataDir: ":memory:", log: () => undefined } });
  registry.register(driver);
  const sessions = new SessionDirectory({ registry, autoReap: false, log: () => undefined, model: () => engine.getModel() });
  const reactor = new ProviderReactor({ engine, sessions, log: () => undefined });
  reactor.start();
  closers.push(() => {
    reactor.stop();
    store.close();
  });
  const project = (await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const created = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
  if (created?.type !== "thread.created") throw new Error("expected thread");
  const threadId = created.thread.id;
  secretValuesFor(engine).remember(threadId, SECRET);
  const settled = events.some((e) => e.type === "settled");
  control.script(...events.filter((e) => e.type !== "session").map(emit), ...(settled ? [] : [emit({ type: "settled", status: "completed" })]));
  await engine.dispatch({ type: "turn.request", threadId, text: "log in" });
  await reactor.drain();
  await engine.drain();
  const tools = Object.values(engine.getModel().activities).filter((a): a is Extract<Activity, { kind: "tool" }> => a.threadId === threadId && a.kind === "tool");
  const reply = Object.values(engine.getModel().messages).filter((m) => m.threadId === threadId && m.role === "assistant").map((m) => m.text).join("");
  return { sent, stored: JSON.stringify(store.readAll()), model: JSON.stringify(engine.getModel()), tools, reply };
}

describe.each([
  ["codex", codex, "mcp:tide.tide_request_secret"],
  ["opencode", opencode, "tide-t1_tide_request_secret"],
  ["pi", pi, "tide/tide_request_secret"],
  ["acp", acp, "tide_tide_request_secret"],
] as const)("secret redaction over the %s normalizer", (_name, build, toolName) => {
  it("the normalized sequence really carries the value (result, split text, shell command)", () => {
    const events = build();
    const tool = events.find((e) => e.type === "activity" && e.activity.kind === "tool" && e.activity.toolName === toolName && e.activity.output !== undefined);
    expect(tool?.type === "activity" && tool.activity.kind === "tool" ? tool.activity.output : "").toContain(SECRET);
    const deltas = events.flatMap((e) => (e.type === "assistant.delta" ? [e.delta] : []));
    expect(deltas.some((d) => d.endsWith(HEAD))).toBe(true);
    expect(deltas.some((d) => d.includes(SECRET))).toBe(false);
    expect(JSON.stringify(events.filter((e) => e.type === "activity" && e.activity.kind === "tool" && e.activity.toolName !== toolName))).toContain(`--with-token ${SECRET}`);
  });

  it("no command the reactor dispatches holds the value", async () => {
    const r = await replayThroughReactor(build());
    expect(r.sent.length).toBeGreaterThan(3);
    expect(JSON.stringify(r.sent)).not.toContain(SECRET);
    expect(r.stored).not.toContain(SECRET);
    expect(r.model).not.toContain(SECRET);
    expect(r.tools.find((a) => a.toolName === toolName)?.output).toBe(`The user provided GITHUB_TOKEN. ${SECRET_MARKER}`);
    expect(JSON.stringify(r.tools.find((a) => a.toolName !== toolName)?.input)).toContain(`--with-token ${REDACTED}`);
    // the value was split across two deltas; the reply holds the marker where it stood
    expect([`Used ${REDACTED} to log in.`, `logged in with ${REDACTED}`].some((s) => r.reply.includes(s))).toBe(true);
  });
});
