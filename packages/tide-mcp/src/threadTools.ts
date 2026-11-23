// Tools for acting on *other* Tide threads. Same privilege ceiling as delegation (enforced
// server-side): an agent can never reach a thread with broader privileges than its own.
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentBackend, ThreadDiffResult, ThreadWaitResult } from "./backend.ts";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
}
export type TextResult = CallToolResult;

const str = (description: string): Record<string, unknown> => ({ type: "string", description });
const num = (description: string): Record<string, unknown> => ({ type: "number", description });
const ok = (value: string): TextResult => ({ content: [{ type: "text", text: value }] });

/** R22: the `images` input of tide_delegate / tide_thread_send. */
export const IMAGES_INPUT: Record<string, unknown> = {
  type: "array",
  items: { type: "string" },
  maxItems: 8,
  description: "Image file paths in your checkout to attach.",
};

/** The `images` argument as a list of paths; anything that is not a non-empty string is dropped. */
export function imagePathsOf(args: Record<string, unknown>): string[] | undefined {
  const raw = args["images"];
  if (!Array.isArray(raw)) return undefined;
  const paths = raw.filter((p): p is string => typeof p === "string" && p !== "");
  return paths.length > 0 ? paths : undefined;
}

/** Appended to the system prompt the server injects (the server picks this up). */
export const THREAD_TOOLS_HINT = [
  "## Tide orchestration",
  "",
  "Ordinary coding tasks need no Tide tools.",
  "",
  "- Sub-agents vs delegates: use your harness's native sub-agent tool (e.g. Claude `Agent`, Codex `spawn_agent`) for same-provider work with default settings. Use `tide_delegate` for another harness/model (Claude, Codex, OpenCode, Pi, Antigravity, Gemini, GLM, a cheaper or free model), custom model/mode settings, or a separate checkout (`useWorktree: true`). Never say cross-harness delegation is impossible, and never create a child's worktree in the shell or ask the child to set up its own checkout.",
  "- Async delegates (no polling): `tide_delegate` is async by default and reports back automatically — when done (background sub-agents included, or on usage limit) you receive \"Delegate ... finished\"; when a child asks a question you receive \"Delegate ... asks\" to answer via `tide_pending_respond` (or ask the user). Never poll `tide_delegate_status`, sleep, or watch files for a running delegate: continue other independent work, or end your turn when none is left. Use `completion: \"wait\"` or `tide_thread_wait` only when you need the result in this turn (a timeout never cancels the child).",
  "- As a sub-agent or delegated child, do the work yourself. Start no sub-agents or delegates unless your task explicitly asks for them.",
  "- Reviews & cleanup: fix small review findings yourself instead of spawning another delegate. Pass `inheritWorktreeFrom` to run a reviewer or tester in an implementer's checkout, and read `tide_thread_diff` before reviewing. When a delegate you spawned is finished and merged or no longer needed, call `tide_thread_archive` to archive it and clean up its worktree (transcript stays readable in Archived).",
  "- Thread & automation tools: `tide_thread_list` / `tide_thread_read` inspect threads (`nextPosition` pages); `tide_thread_send` sends follow-ups (`auto`/`queue`/`steer`); `tide_thread_interrupt` stops a running turn; `tide_pending_list` / `tide_pending_respond` answer pending questions (you cannot approve another thread's tool calls, and you can only act on threads whose privileges are no broader than yours). `tide_schedule_task` (with update/list/delete/run-now) manages project automations. Pass `clientRequestId` for idempotent sends/delegations.",
  "- Directives, secrets & attachments: when the user's message carries a \"Delegate to:\" line naming a provider, providerId and optional model, call `tide_delegate` with those exact ids (`completion: \"wait\"` when needed in this reply). Need an API key or token? Call tide_request_secret — never ask for secrets in chat. For user-attached images listed under the message, put paths in the prompt for same-harness sub-agents, or pass the paths in `images` to tide_delegate or tide_thread_send (delegates have separate checkouts).",
  "- Tide MCP tools may load late. Try the tool name once before reporting it absent.",
].join("\n");

export const THREAD_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "tide_thread_list",
    description:
      "List Tide threads in this project (or another with projectId), newest first, as a compact table: id, title, provider, status, attention, role. Use it to find a thread before reading or messaging it. Delegated child threads are hidden unless includeDelegates is true.",
    inputSchema: {
      type: "object",
      properties: {
        projectId: str("Project to list; defaults to your own."),
        includeDelegates: { type: "boolean", description: "Also list threads created by delegation." },
        title: str("Case-insensitive title filter."),
        limit: num("Max rows, 1-100."),
      },
    },
  },
  {
    name: "tide_thread_read",
    description:
      "Read another thread's durable timeline, bounded. view=messages (default) shows the conversation; view=activity includes tool calls and approvals. Items print as `[kind; turn=...; pos=n] text`. If more remains, call again with afterPosition set to the reported nextPosition.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: str("Thread to read."),
        view: { type: "string", enum: ["messages", "activity"], description: "What to include. Default messages." },
        afterPosition: num("Continue after this position (use nextPosition from a previous read)."),
        limit: num("Max items, 1-200."),
        maxCharsPerItem: num("Truncate each item to this many characters, 200-20000."),
      },
      required: ["threadId"],
    },
  },
  {
    name: "tide_thread_send",
    description:
      "Send a message to another thread. mode auto (default) steers a running turn when the harness supports it, otherwise queues; queue always waits for the current turn; steer fails if nothing is running. Reports whether it started, queued or steered. Pass clientRequestId so a retry does not send twice.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: str("Target thread."),
        text: str("The message."),
        mode: { type: "string", enum: ["auto", "queue", "steer"], description: "Delivery mode. Default auto." },
        freshSession: {
          type: "boolean",
          description: "Start the target on a brand-new harness session: its native context is dropped, Tide history stays. Refused while the target is running and with mode steer.",
        },
        images: IMAGES_INPUT,
        clientRequestId: str("Idempotency key."),
      },
      required: ["threadId", "text"],
    },
  },
  {
    name: "tide_thread_wait",
    description:
      "Wait until a thread is done: its live turn settled and any background sub-agents it launched reported back and the turn that follows settled (returns at once if idle). Then report status, settled, timedOut, attention, its last assistant text and any error. A timeout only stops your waiting; the thread keeps running, and status names the background sub-agents still working. If attention is set, the thread is blocked on a question or approval: use tide_pending_list.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: str("Thread to wait on."),
        turnId: str("Wait for this specific turn."),
        timeoutMs: num("1000-600000, default 600000."),
      },
      required: ["threadId"],
    },
  },
  {
    name: "tide_thread_diff",
    description:
      "Show what a thread changed since its first turn (its checkpoint before that turn → its working tree): one `path (+added −deleted)` header per file, then the patch, each cut at maxCharsPerFile. Use it to review another thread's work, e.g. the implementer's branch you were asked to review.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: str("Thread whose changes to show."),
        maxCharsPerFile: num("Cut each file's patch at this many characters, 500-50000, default 8000."),
      },
      required: ["threadId"],
    },
  },
  {
    name: "tide_thread_interrupt",
    description: "Interrupt a thread's running turn. The thread stays usable; send it a new message afterwards.",
    inputSchema: { type: "object", properties: { threadId: str("Thread to interrupt.") }, required: ["threadId"] },
  },
  {
    name: "tide_thread_archive",
    description:
      "Archive a finished child or delegate thread you spawned so it leaves the active inbox and its git worktree is cleaned up (uncommitted changes are snapshotted; transcript stays readable in Archived). Refused while running, waiting on attention, or for threads that are not your descendants.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: str("Child or delegate thread to archive."),
        keepWorktree: { type: "boolean", description: "Keep the git worktree on disk instead of removing it. Default false." },
      },
      required: ["threadId"],
    },
  },
  {
    name: "tide_pending_list",
    description:
      "List the questions a thread is waiting on (requestId and each question with its options). Only questions are shown: agents cannot approve tool calls, those stay with the user.",
    inputSchema: { type: "object", properties: { threadId: str("Thread to inspect.") }, required: ["threadId"] },
  },
  {
    name: "tide_pending_respond",
    description:
      "Answer a pending question on a thread. `answers` maps each question id to the chosen option label (or free text; an array for multi-select questions). Questions only: agents cannot approve tool calls.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: str("Thread that asked."),
        requestId: str("requestId from tide_pending_list."),
        answers: { type: "object", description: "Question id -> answer.", additionalProperties: true },
      },
      required: ["threadId", "requestId", "answers"],
    },
  },
];

const THREAD_TOOL_NAMES = new Set(THREAD_TOOL_DEFINITIONS.map((d) => d.name));
export const isThreadTool = (name: string): boolean => THREAD_TOOL_NAMES.has(name);

function reqStr(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || v.length === 0) throw new Error(`\`${key}\` is required`);
  return v;
}
const optStr = (args: Record<string, unknown>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
};
const optNum = (args: Record<string, unknown>, key: string): number | undefined => {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
};

/** Maps wire error codes to messages the model can act on; other errors pass through. */
export function describeRpcError(err: unknown): string {
  const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "forbidden") return `Not allowed: that thread needs narrower privileges than yours to be reachable, or the action is reserved for the user (${message}).`;
  if (code === "not-found") return `Not found: no such thread or request (${message}). Use tide_thread_list to find valid ids.`;
  if (code === "busy") return `Busy: ${message}`;
  if (code === "conflict") return `Conflict: ${message}`;
  return message;
}

const oneLine = (s: string): string => s.replace(/\s+/g, " ").trim();
const bound = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max)}... [truncated]` : s);
const WAIT_TEXT_MAX = 8000;

export function formatWait(r: ThreadWaitResult): string {
  const lines = [
    `status: ${r.status}`,
    `settled: ${r.settled}`,
    `timedOut: ${r.timedOut}`,
    ...(r.attention !== undefined ? [`attention: ${r.attention}`] : []),
    ...(r.error !== undefined ? [`error: ${r.error}`] : []),
  ];
  if (r.timedOut) {
    const background = r.status.startsWith("working (") ? " Its background sub-agents are still working; it is not stuck." : "";
    lines.push(`Waiting timed out; the thread keeps running.${background} Wait again or read it later.`);
  }
  if (r.lastAssistantText) lines.push("lastAssistantText:", bound(r.lastAssistantText, WAIT_TEXT_MAX));
  return lines.join("\n");
}

export function formatDiff(r: ThreadDiffResult): string {
  if (r.files.length === 0) return "No changes.";
  const added = r.files.reduce((n, f) => n + f.additions, 0);
  const deleted = r.files.reduce((n, f) => n + f.deletions, 0);
  const out = [`${r.files.length} file${r.files.length === 1 ? "" : "s"} changed (+${added} −${deleted}), ${r.base.slice(0, 12)} → ${r.head}`];
  for (const f of r.files) {
    out.push("", `${f.path} (+${f.additions} −${f.deletions})${f.status !== "modified" ? ` [${f.status}]` : ""}`);
    if (f.patch === undefined) out.push("(binary or no textual patch)");
    else out.push(f.patch.trimEnd(), ...(f.truncated ? ["... [patch truncated; raise maxCharsPerFile or read the file]"] : []));
  }
  return out.join("\n");
}

/** Handles tide_thread_* and tide_pending_*; throws raw errors (the caller maps them). */
export async function callThreadTool(backend: AgentBackend, name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<TextResult> {
  switch (name) {
    case "tide_thread_list": {
      const projectId = optStr(args, "projectId");
      const title = optStr(args, "title");
      const limit = optNum(args, "limit");
      const { threads } = await backend.threadList({
        ...(projectId !== undefined ? { projectId } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(args["includeDelegates"] === true ? { includeDelegates: true } : {}),
      });
      if (threads.length === 0) return ok("No threads.");
      const rows = threads.map((t) => [t.id, oneLine(t.title), t.provider, t.status, t.attention ?? "-", t.role ?? "-"].join(" | "));
      return ok(["id | title | provider | status | attention | role", ...rows].join("\n"));
    }
    case "tide_thread_read": {
      const view = optStr(args, "view");
      const afterPosition = optNum(args, "afterPosition");
      const limit = optNum(args, "limit");
      const maxCharsPerItem = optNum(args, "maxCharsPerItem");
      const r = await backend.threadRead({
        threadId: reqStr(args, "threadId"),
        ...(view === "messages" || view === "activity" ? { view } : {}),
        ...(afterPosition !== undefined ? { afterPosition } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(maxCharsPerItem !== undefined ? { maxCharsPerItem } : {}),
      });
      const head = `${r.thread.title} (${r.thread.provider}, ${r.thread.status}${r.thread.attention ? `, attention: ${r.thread.attention}` : ""})`;
      const lines = r.items.map((i) => `[${i.kind}; turn=${i.turnId}; pos=${i.position}]${i.truncated ? " (item truncated)" : ""} ${i.text}`);
      if (lines.length === 0) lines.push("(no items)");
      if (r.truncated) lines.push(`More items remain: call again with afterPosition=${r.nextPosition}.`);
      else lines.push(`End of timeline. nextPosition=${r.nextPosition}`);
      return ok([head, ...lines].join("\n"));
    }
    case "tide_thread_send": {
      const mode = optStr(args, "mode");
      const clientRequestId = optStr(args, "clientRequestId");
      const imagePaths = imagePathsOf(args);
      const r = await backend.threadSend({
        threadId: reqStr(args, "threadId"),
        text: reqStr(args, "text"),
        ...(mode === "auto" || mode === "queue" || mode === "steer" ? { mode } : {}),
        ...(args["freshSession"] === true ? { freshSession: true } : {}),
        ...(imagePaths !== undefined ? { imagePaths } : {}),
        ...(clientRequestId !== undefined ? { commandId: clientRequestId } : {}),
      });
      const how = { started: "started a new turn", queued: "queued behind the running turn", steered: "steered the running turn" }[r.delivered];
      return ok(`Message ${how}.${r.turnId ? ` turnId=${r.turnId}` : ""}\n${JSON.stringify(r)}`);
    }
    case "tide_thread_wait": {
      const turnId = optStr(args, "turnId");
      const timeoutMs = optNum(args, "timeoutMs");
      return ok(
        formatWait(
          await backend.threadWait({
            threadId: reqStr(args, "threadId"),
            ...(turnId !== undefined ? { turnId } : {}),
            // the server accepts 1000-600000; a longer ask waits the maximum
            ...(timeoutMs !== undefined ? { timeoutMs: Math.min(Math.max(timeoutMs, 1000), 600_000) } : {}),
          }, signal),
        ),
      );
    }
    case "tide_thread_diff": {
      const maxCharsPerFile = optNum(args, "maxCharsPerFile");
      return ok(formatDiff(await backend.threadDiff({ threadId: reqStr(args, "threadId"), ...(maxCharsPerFile !== undefined ? { maxCharsPerFile } : {}) })));
    }
    case "tide_thread_interrupt": {
      const r = await backend.threadInterrupt(reqStr(args, "threadId"));
      return ok(r.ok ? "Interrupted." : "Nothing to interrupt.");
    }
    case "tide_thread_archive": {
      const r = await backend.threadArchive({
        threadId: reqStr(args, "threadId"),
        ...(args["keepWorktree"] === true ? { keepWorktree: true } : {}),
      });
      return ok(r.worktreeRemoved ? "Archived. Worktree removed." : "Archived.");
    }
    case "tide_pending_list": {
      const { questions } = await backend.pendingList(reqStr(args, "threadId"));
      if (questions.length === 0) return ok("No pending questions.");
      const out = questions.map((q) => {
        const qs = q.questions.map((x) => {
          const opts = x.options?.map((o) => o.label).join(" / ");
          return `  - ${x.id}${x.multi ? " (multi)" : ""}: ${x.text}${opts ? ` [${opts}]` : ""}`;
        });
        return [`requestId=${q.requestId}`, ...qs].join("\n");
      });
      return ok(out.join("\n"));
    }
    case "tide_pending_respond": {
      const answers = args["answers"];
      if (typeof answers !== "object" || answers === null || Array.isArray(answers)) throw new Error("`answers` must be an object mapping question id to answer");
      const r = await backend.pendingRespond({ threadId: reqStr(args, "threadId"), requestId: reqStr(args, "requestId"), answers: answers as Record<string, unknown> });
      return ok(r.ok ? "Answered." : "The question was not answered (already resolved?).");
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}
