/**
 * A scripted Agent Client Protocol agent for the browser smoke test. Tide runs it as an ACP
 * provider instance (`command: node`, `args: [this file]`), exactly as it runs Gemini CLI or
 * Goose, so the server needs no test hook. ndjson JSON-RPC on stdio; no network, no model.
 *
 * Script, keyed on the prompt text (Tide prepends its preamble to the first prompt, so match
 * with `includes`):
 * - a prompt containing EDIT_TRIGGER streams two text chunks, announces an `edit` tool call on
 *   `hello.txt` with its diff, asks permission, and on approval writes the file through the
 *   client's `fs/write_text_file` (served by Tide inside the worktree), then finishes the reply;
 * - any other prompt is answered with `Echo: <prompt>`.
 */
import { createInterface } from "node:readline";
import { join } from "node:path";
import { EDIT_TRIGGER, FINAL_TEXT, NEW_CONTENT, OLD_CONTENT, STREAM_CHUNKS } from "./script.ts";

type Id = number | string;
interface Message {
  jsonrpc?: "2.0";
  id?: Id | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const send = (message: Message): void => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
};

let nextOutId = 1;
const waiting = new Map<Id, (message: Message) => void>();
/** agent → client request; resolves with the client's response */
function request(method: string, params: Record<string, unknown>): Promise<Message> {
  const id = `agent-${nextOutId++}`;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

const sessions = new Map<string, { cwd: string; cancel?: () => void }>();
let sessionSeq = 0;

function update(sessionId: string, body: Record<string, unknown>): void {
  send({ method: "session/update", params: { sessionId, update: body } });
}

function promptText(params: Record<string, unknown>): string {
  const blocks = Array.isArray(params["prompt"]) ? (params["prompt"] as { type?: string; text?: string }[]) : [];
  return blocks.map((block) => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

async function editTurn(sessionId: string, cwd: string, cancelled: Promise<"cancelled">): Promise<string> {
  for (const text of STREAM_CHUNKS) update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  const path = join(cwd, "hello.txt");
  const toolCallId = "call-edit-1";
  update(sessionId, {
    sessionUpdate: "tool_call",
    toolCallId,
    title: "Edit hello.txt",
    kind: "edit",
    status: "pending",
    locations: [{ path }],
    rawInput: { path, oldString: "hello", newString: "hello e2e world" },
    content: [{ type: "diff", path, oldText: OLD_CONTENT, newText: NEW_CONTENT }],
  });
  const answer = await Promise.race([
    request("session/request_permission", {
      sessionId,
      toolCall: { toolCallId, title: "Edit hello.txt", kind: "edit" },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" },
        { optionId: "reject", name: "Reject", kind: "reject_once" },
      ],
    }),
    cancelled,
  ]);
  if (answer === "cancelled") return "cancelled";
  const outcome = (answer.result as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
  if (outcome?.outcome !== "selected" || outcome.optionId !== "allow") {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed" });
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Edit declined." } });
    return "end_turn";
  }
  update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
  const wrote = await request("fs/write_text_file", { sessionId, path, content: NEW_CONTENT });
  if (wrote.error) {
    update(sessionId, { sessionUpdate: "tool_call_update", toolCallId, status: "failed", content: [{ type: "content", content: { type: "text", text: wrote.error.message } }] });
    return "end_turn";
  }
  update(sessionId, {
    sessionUpdate: "tool_call_update",
    toolCallId,
    status: "completed",
    content: [
      { type: "content", content: { type: "text", text: "Edited hello.txt" } },
      { type: "diff", path, oldText: OLD_CONTENT, newText: NEW_CONTENT },
    ],
  });
  update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: FINAL_TEXT } });
  return "end_turn";
}

async function prompt(id: Id, params: Record<string, unknown>): Promise<void> {
  const sessionId = String(params["sessionId"]);
  const session = sessions.get(sessionId);
  if (!session) {
    send({ id, error: { code: -32602, message: `unknown session ${sessionId}` } });
    return;
  }
  const cancelled = new Promise<"cancelled">((resolve) => {
    session.cancel = () => resolve("cancelled");
  });
  const text = promptText(params);
  let stopReason: string;
  if (text.includes(EDIT_TRIGGER)) stopReason = await editTurn(sessionId, session.cwd, cancelled);
  else {
    const last = text.trim().split("\n").at(-1) ?? "";
    update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `Echo: ${last}` } });
    stopReason = "end_turn";
  }
  delete session.cancel;
  send({ id, result: { stopReason } });
}

const MODEL_OPTION = { id: "model", name: "Model", category: "model", type: "select", currentValue: "scripted", options: [{ value: "scripted", name: "Scripted" }] };

function handle(message: Message): void {
  if (message.method === undefined) {
    // a response to one of our requests
    const resolve = message.id !== undefined && message.id !== null ? waiting.get(message.id) : undefined;
    if (resolve && message.id !== undefined && message.id !== null) {
      waiting.delete(message.id);
      resolve(message);
    }
    return;
  }
  const id = message.id;
  const params = message.params ?? {};
  switch (message.method) {
    case "initialize":
      send({ id: id ?? null, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: {} }, authMethods: [], agentInfo: { name: "Tide E2E Agent", version: "1.0.0" } } });
      return;
    case "session/new": {
      sessionSeq += 1;
      const sessionId = `e2e-${process.pid}-${sessionSeq}`;
      sessions.set(sessionId, { cwd: String(params["cwd"]) });
      send({ id: id ?? null, result: { sessionId, configOptions: [MODEL_OPTION] } });
      return;
    }
    case "session/load":
      sessions.set(String(params["sessionId"]), { cwd: String(params["cwd"]) });
      send({ id: id ?? null, result: { configOptions: [MODEL_OPTION] } });
      return;
    case "session/prompt":
      if (id !== undefined && id !== null) void prompt(id, params);
      return;
    case "session/cancel":
      sessions.get(String(params["sessionId"]))?.cancel?.();
      return;
    default:
      if (id !== undefined && id !== null) send({ id, result: {} });
  }
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (line.trim() === "") return;
  try {
    handle(JSON.parse(line) as Message);
  } catch (error) {
    process.stderr.write(`fake-agent: bad line: ${String(error)}\n`);
  }
});
// Tide closing the pipe (or the server dying) ends the agent: no orphans
lines.on("close", () => process.exit(0));
