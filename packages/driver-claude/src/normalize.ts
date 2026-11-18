import { randomUUID } from "node:crypto";
import type { NormalizedEvent } from "@tide/contracts";
import { COMPACTING_TEXT, compactedText } from "./compaction.ts";
import type {
  AssistantMessage,
  ClaudeMessage,
  ContentBlock,
  RateLimitMessage,
  ResultMessage,
  StreamEventMessage,
  SystemInitMessage,
  SystemOtherMessage,
  ToolResultBlock,
  ToolUseBlock,
  UserMessage,
} from "./sdk-shapes.ts";
import { rateLimitEvents, UsageTracker } from "./usage.ts";

const MAX_OUTPUT_CHARS = 4096;
const MAX_PAYLOAD_CHARS = 4096;
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
/** Cap for a sub-agent's final report carried on its child row. */
export const MAX_REPORT_CHARS = 8192;
/** The tool_result a backgrounded/async sub-agent returns at once; its real result arrives later. */
const BACKGROUND_PLACEHOLDER = /running in the background|async agent launched|launched (successfully )?in the background/i;

/**
 * The only frames dropped without a trace (CLAUDE.md §1a: unknown events are passed
 * through, not swallowed). Everything here is content-free housekeeping the CLI emits
 * per request; anything else that is not modelled becomes a generic `info` activity
 * carrying the raw frame.
 */
const TASK_STATUS: Record<string, "running" | "done" | "error"> = {
  pending: "running",
  running: "running",
  paused: "running",
  completed: "done",
  failed: "error",
  killed: "error",
};

/** Top-level frames that are pure bookkeeping for the SDK's own message queue. */
const SILENT_MESSAGE_TYPES = new Set([
  "command_lifecycle", // queued/started/completed/cancelled per user-message uuid — one per prompt, no content
]);

const SILENT_SYSTEM_SUBTYPES = new Set([
  "status", // per-request spinner state (requesting/…); `compacting` is handled before this set is read
  "background_tasks_changed", // level signal duplicating the task_* bookends the child rows already show
  "thinking_tokens", // live thinking-token estimate for a progress pill
]);

export interface NormalizerOptions {
  /** true when the session runs with `includePartialMessages` (assistant text arrives as deltas) */
  partialMessages: boolean;
  /** called for messages the normalizer does not model; never throws */
  onUnknown?: (type: string, subtype?: string) => void;
  /** clock for `rateLimit.at` (tests) */
  now?: () => number;
  /** id for the compaction row, so "Compacting…" and "Context compacted" land on one row (tests) */
  newId?: () => string;
  /** the session's usage tracker, which outlives this normalizer (a fresh one when omitted) */
  usage?: UsageTracker;
}

interface TrackedTool {
  toolName: string;
  input: unknown;
  parentToolUseId: string | null;
  childName?: string;
}

export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/** Raw harness frame for a pass-through info activity; large frames degrade to truncated JSON. */
export function rawPayload(value: unknown): unknown {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
  return json.length <= MAX_PAYLOAD_CHARS ? value : truncate(json, MAX_PAYLOAD_CHARS);
}

function toolResultText(block: ToolResultBlock): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter((part) => part !== "")
    .join("\n");
}

/** A sub-agent's final result, capped; truncation is marked with "…". */
export function capReport(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_REPORT_CHARS ? trimmed : `${trimmed.slice(0, MAX_REPORT_CHARS).trimEnd()}…`;
}

function firstLine(text: string): string | undefined {
  const line = text.split("\n").find((l) => l.trim() !== "");
  if (line === undefined) return undefined;
  return truncate(line.trim().replace(/^#+\s*/, ""), 1000);
}

/** One XML-ish field of a `<task-notification>` user message, as the model reads it. */
function tagText(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match?.[1]?.trim();
}

/** The quoted name in the CLI's `Agent "<name>" finished` summary. */
function summaryName(summary: string | undefined): string | undefined {
  return /"([^"]+)"/.exec(summary ?? "")?.[1];
}

/** The agent id a background `Task`/`Agent` placeholder result carries (`agentId: <id>`). */
function placeholderAgentId(text: string): string | undefined {
  return /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1];
}

/** Text of a user message: a plain string or its text blocks. */
function userText(content: string | ContentBlock[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (block.type === "text" ? ((block as { text?: string }).text ?? "") : "")).join("\n");
}

function planSteps(input: unknown): { text: string; status: "pending" | "in_progress" | "completed" }[] | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const todos = (input as Record<string, unknown>)["todos"];
  if (!Array.isArray(todos)) return undefined;
  const steps: { text: string; status: "pending" | "in_progress" | "completed" }[] = [];
  for (const raw of todos) {
    if (typeof raw !== "object" || raw === null) continue;
    const todo = raw as Record<string, unknown>;
    const text = typeof todo["content"] === "string" ? todo["content"] : typeof todo["activeForm"] === "string" ? todo["activeForm"] : undefined;
    if (text === undefined) continue;
    const status = todo["status"];
    steps.push({ text, status: status === "in_progress" || status === "completed" ? status : "pending" });
  }
  return steps.length > 0 ? steps : undefined;
}

/**
 * Stateful but I/O-free translator from Claude Code's SDK message stream to
 * `NormalizedEvent`s. State is only what the stream itself cannot repeat: the current
 * streamed message id (for delta keys) and open tool calls (to fill name/input on results).
 */
export class ClaudeNormalizer {
  #opts: NormalizerOptions;
  #streamMessageId: string | undefined;
  #tools = new Map<string, TrackedTool>();
  #tasks = new Map<string, { name: string; childKey: string; description?: string }>();
  /**
   * Every child row this session opened, by childKey, plus task_id -> childKey. Kept past
   * completion: a background sub-agent reports back via task_notification, often a turn later.
   */
  #children = new Map<string, { name: string; description?: string; backgrounded: boolean; summarised: boolean; settled?: boolean }>();
  #taskChild = new Map<string, string>();
  #interrupted = false;
  /** the "Compacting conversation…" row in flight; its compact_boundary replaces it */
  #compactingId: string | undefined;
  #usage: UsageTracker;
  unknownCount = 0;

  constructor(options: NormalizerOptions) {
    this.#opts = options;
    this.#usage = options.usage ?? new UsageTracker();
  }

  /** Backgrounded sub-agents that have not reported yet (they keep Claude Code busy between turns). */
  backgroundCount(): number {
    let count = 0;
    for (const child of this.#children.values()) if (child.backgrounded && child.settled !== true) count++;
    return count;
  }

  /**
   * The CLI process is gone: every backgrounded sub-agent that has not reported never will.
   * Returns their final rows (`error`, with `summary`) and stops counting them.
   */
  abandonBackground(summary: string): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    for (const [childKey, child] of this.#children) {
      if (!child.backgrounded || child.settled === true) continue;
      child.settled = true;
      out.push({ type: "activity", activity: { kind: "child", childKey, name: child.name, status: "error", ...(child.description ? { description: child.description } : {}), summary } });
    }
    return out;
  }

  /**
   * The sub-agent a `<task-notification>` user message reports on: the tracked child's name,
   * else the CLI's `Agent "<name>" finished` summary. Undefined for any other message.
   */
  notificationName(message: ClaudeMessage): string | undefined {
    if (message.type !== "user") return undefined;
    const text = userText((message as UserMessage).message?.content);
    if (!text.includes("<task-notification>")) return undefined;
    const taskId = tagText(text, "task-id");
    const childKey = (taskId !== undefined ? this.#taskChild.get(taskId) : undefined) ?? tagText(text, "tool-use-id");
    const known = childKey !== undefined ? this.#children.get(childKey)?.name : undefined;
    return known ?? summaryName(tagText(text, "summary")) ?? "background task";
  }

  /** Marks the turn as user-interrupted so the terminal `result` settles as `interrupted`. */
  markInterrupted(): void {
    this.#interrupted = true;
  }

  next(message: ClaudeMessage): NormalizedEvent[] {
    switch (message.type) {
      case "system":
        return this.#system(message as SystemInitMessage | SystemOtherMessage);
      case "stream_event":
        return this.#streamEvent(message as StreamEventMessage);
      case "assistant":
        return this.#assistant(message as AssistantMessage);
      case "user":
        return this.#user(message as UserMessage);
      case "result":
        return this.#result(message as ResultMessage);
      case "rate_limit_event":
        return this.#rateLimit(message as RateLimitMessage);
      default:
        if (SILENT_MESSAGE_TYPES.has(message.type)) return [];
        return this.#unknown(message, message.type, (message as { subtype?: string }).subtype);
    }
  }

  /**
   * Pass-through for anything Tide does not model: the row still appears, generically,
   * carrying the raw frame (CLAUDE.md §1a "pass through, don't translate").
   */
  #unknown(raw: unknown, type: string, subtype?: string): NormalizedEvent[] {
    this.unknownCount++;
    this.#opts.onUnknown?.(type, subtype);
    return [{ type: "activity", activity: { kind: "info", text: `claude: ${type}${subtype ? `/${subtype}` : ""}`, payload: rawPayload(raw) } }];
  }

  #info(text: string): NormalizedEvent[] {
    return [{ type: "activity", activity: { kind: "info", text } }];
  }

  #system(message: SystemInitMessage | SystemOtherMessage): NormalizedEvent[] {
    if (message.subtype === "init") {
      const init = message as SystemInitMessage;
      return [{ type: "session", nativeSessionId: init.session_id, ...(init.model ? { model: init.model } : {}) }];
    }
    const other = message as SystemOtherMessage;
    if (other.subtype === "permission_denied") {
      const reason = other.decision_reason ?? other.message ?? "no reason given";
      return this.#info(`Permission denied for ${other.tool_name ?? "tool"}: ${truncate(reason, 300)}`);
    }
    if (other.subtype === "api_retry") {
      return this.#info(`Retrying API request (attempt ${other.attempt ?? "?"}/${other.max_retries ?? "?"}${other.error ? `, ${other.error}` : ""})`);
    }
    if (other.subtype === "compact_boundary") {
      const id = this.#compactingId ?? this.#newId();
      this.#compactingId = undefined;
      return [{ type: "activity", activity: { id, kind: "info", text: compactedText(other.compact_metadata) } }];
    }
    if (other.subtype === "status") return this.#status(other);
    if (other.subtype === "task_started" || other.subtype === "task_updated" || other.subtype === "task_progress") {
      return this.#task(other);
    }
    if (other.subtype === "task_notification") return this.#taskNotification(other);
    if (SILENT_SYSTEM_SUBTYPES.has(other.subtype)) return [];
    return this.#unknown(other, "system", other.subtype);
  }

  /**
   * Background tasks / subagents (`SDKTaskStarted|Updated|Progress`). A task with an id
   * becomes a child activity; it is keyed by `tool_use_id` when the CLI gives one, so a
   * foreground `Task` tool call and its task frames land on the *same* child row.
   * `ambient`/`skip_transcript` tasks are the CLI's own housekeeping and stay hidden.
   */
  #task(message: SystemOtherMessage): NormalizedEvent[] {
    if (message.ambient === true || message.skip_transcript === true) return [];
    const taskId = message.task_id;
    if (taskId === undefined) return this.#unknown(message, "system", message.subtype);

    if (message.subtype === "task_started") {
      const childKey = message.tool_use_id ?? taskId;
      const name = message.description ?? message.subagent_type ?? "Background task";
      const known = this.#children.get(childKey);
      const description = message.subagent_type ?? known?.description;
      const entry = { name, childKey, ...(description ? { description } : {}) };
      this.#tasks.set(taskId, entry);
      this.#taskChild.set(taskId, childKey);
      this.#children.set(childKey, {
        ...entry,
        backgrounded: message.is_backgrounded === true || (known?.backgrounded ?? false),
        summarised: known?.summarised ?? false,
      });
      return [{ type: "activity", activity: { kind: "child", childKey, taskId, name, status: "running", ...(description ? { description } : {}) } }];
    }

    const tracked = this.#tasks.get(taskId);
    // later frames carry no tool_use_id: the child row is the one task_started opened
    const childKey = tracked?.childKey ?? message.tool_use_id ?? taskId;
    const name = message.patch?.description ?? message.description ?? tracked?.name ?? "Background task";
    const child = this.#children.get(childKey);
    if (child && message.patch?.is_backgrounded === true) child.backgrounded = true;
    if (message.subtype === "task_progress") {
      const summary = message.summary ?? (message.last_tool_name ? `Running ${message.last_tool_name}` : undefined);
      if (child && message.summary) child.summarised = true;
      return [
        {
          type: "activity",
          activity: { kind: "child", childKey, name, status: "running", ...(tracked?.description ? { description: tracked.description } : {}), ...(summary ? { summary: truncate(summary, 1000) } : {}) },
        },
      ];
    }
    const status = TASK_STATUS[message.patch?.status ?? "running"] ?? "running";
    if (status !== "running") {
      this.#tasks.delete(taskId);
      if (child) child.settled = true;
    }
    const summary = message.patch?.error;
    return [
      {
        type: "activity",
        activity: { kind: "child", childKey, name, status, ...(tracked?.description ? { description: tracked.description } : {}), ...(summary ? { summary: truncate(summary, 1000) } : {}) },
      },
    ];
  }

  /**
   * `SDKTaskNotificationMessage`: a background task settled. Its `summary` is the CLI's
   * one-liner ("Agent … completed"), used only when the row has no summary yet.
   */
  #taskNotification(message: SystemOtherMessage): NormalizedEvent[] {
    if (message.ambient === true || message.skip_transcript === true) return [];
    const taskId = message.task_id;
    if (taskId === undefined) return this.#unknown(message, "system", message.subtype);
    // the launching tool_use_id is the row's key; the task id alone (a fresh normalizer after a
    // reset or restart) is carried as taskId so the server still finds the original row
    const childKey = this.#taskChild.get(taskId) ?? message.tool_use_id ?? taskId;
    this.#tasks.delete(taskId);
    const name = summaryName(message.summary);
    return this.#settleChild(childKey, message.status === "completed" ? "done" : "error", {
      ...(message.summary !== undefined ? { summary: message.summary } : {}),
      weak: true,
      taskId,
      ...(name !== undefined ? { fallbackName: name } : {}),
    });
  }

  /** The final child update: status, optional report, and a summary only when none was shown. */
  #settleChild(childKey: string, status: "done" | "error", fields: { summary?: string; weak?: boolean; report?: string; parentToolUseId?: string | null; fallbackName?: string; taskId?: string }): NormalizedEvent[] {
    const child = this.#children.get(childKey);
    if (child) child.settled = true;
    const name = child?.name ?? fields.fallbackName ?? "Background task";
    const summary = child?.summarised ? undefined : fields.summary !== undefined && fields.summary.trim() !== "" ? truncate(fields.summary.trim(), 1000) : undefined;
    // the CLI's "Agent … completed" one-liner may still be replaced by the result's first line
    if (child && summary !== undefined && fields.weak !== true) child.summarised = true;
    return [
      {
        type: "activity",
        activity: {
          kind: "child",
          childKey,
          ...(fields.taskId !== undefined ? { taskId: fields.taskId } : {}),
          name,
          status,
          ...(child?.description ? { description: child.description } : {}),
          ...(summary !== undefined ? { summary } : {}),
          ...(fields.report ? { report: fields.report } : {}),
          ...(fields.parentToolUseId ? { parentToolUseId: fields.parentToolUseId } : {}),
        },
      },
    ];
  }

  /**
   * The user message a background sub-agent's result is delivered in
   * (`origin.kind: "task-notification"`): `<task-notification>` with `<tool-use-id>`,
   * `<task-id>`, `<status>`, `<summary>` and `<result>` fields.
   */
  #notificationMessage(text: string): NormalizedEvent[] {
    const toolUseId = tagText(text, "tool-use-id");
    const taskId = tagText(text, "task-id");
    // an unknown child (fresh normalizer after a reset or restart) still settles: keyed by the
    // launching tool_use_id with taskId, the server lands it on the row the launch opened
    const childKey = (taskId !== undefined ? this.#taskChild.get(taskId) : undefined) ?? toolUseId ?? taskId;
    if (childKey === undefined) return [];
    const result = tagText(text, "result");
    const report = result ? capReport(result) : undefined;
    const statusText = tagText(text, "status");
    const status = statusText === undefined || statusText === "completed" ? "done" : "error";
    const summary = report ? firstLine(report) : tagText(text, "summary");
    const name = summaryName(tagText(text, "summary"));
    return this.#settleChild(childKey, status, {
      ...(summary !== undefined ? { summary } : {}),
      ...(report ? { report } : {}),
      ...(taskId !== undefined ? { taskId } : {}),
      ...(name !== undefined ? { fallbackName: name } : {}),
    });
  }

  #newId(): string {
    return (this.#opts.newId ?? randomUUID)();
  }

  /**
   * `SDKStatusMessage`: `status: "compacting"` while Claude Code summarises the conversation
   * (manual `/compact` or auto-compaction), then `status: null` with `compact_result`. The
   * live row is replaced in place by the compact_boundary that follows; a failure turns it
   * into an error. `requesting` is per-request spinner noise.
   */
  #status(message: SystemOtherMessage): NormalizedEvent[] {
    if (message.status === "compacting") {
      if (this.#compactingId !== undefined) return [];
      this.#compactingId = this.#newId();
      return [{ type: "activity", activity: { id: this.#compactingId, kind: "info", text: COMPACTING_TEXT } }];
    }
    if (message.compact_result === "failed") {
      const id = this.#compactingId ?? this.#newId();
      this.#compactingId = undefined;
      const reason = message.compact_error ? `: ${truncate(message.compact_error, 300)}` : "";
      return [{ type: "activity", activity: { id, kind: "error", text: `Compaction failed${reason}` } }];
    }
    return [];
  }

  #rateLimit(message: RateLimitMessage): NormalizedEvent[] {
    const info = message.rate_limit_info;
    const events = rateLimitEvents(info, (this.#opts.now ?? Date.now)());
    // A nominal frame is per-request housekeeping: it feeds the gauge but earns no timeline row.
    const own = events.at(-1);
    if (info && own?.type === "usage" && info.status !== "allowed") {
      const remaining = own.rateLimit?.remainingPct;
      events.push(...this.#info(`Rate limit ${info.status}${info.rateLimitType ? ` on ${info.rateLimitType}` : ""}${remaining !== undefined ? ` (${100 - remaining}% used)` : ""}`));
    }
    return events;
  }

  #streamEvent(message: StreamEventMessage): NormalizedEvent[] {
    // Subagent text is surfaced through the child activity, not the main message stream.
    if (message.parent_tool_use_id !== null) return [];
    const event = message.event;
    if (event.type === "message_start") {
      const id = (event as { message?: { id?: string } }).message?.id;
      this.#streamMessageId = id ?? message.uuid;
      return [];
    }
    if (event.type !== "content_block_delta") return [];
    const delta = (event as { index: number; delta: { type: string; text?: string; thinking?: string } }).delta;
    // The key is the *message* id, not the block index: reasoning and the text that follows
    // it are different content blocks of one message and must merge into one bubble.
    const key = this.#streamMessageId ?? message.uuid ?? "msg";
    if (delta.type === "thinking_delta") {
      const thinking = delta.thinking;
      if (typeof thinking !== "string" || thinking === "") return [];
      return [{ type: "assistant.reasoning", messageKey: key, delta: thinking }];
    }
    if (delta.type !== "text_delta" || typeof delta.text !== "string" || delta.text === "") return [];
    return [{ type: "assistant.delta", messageKey: key, delta: delta.text }];
  }

  #assistant(message: AssistantMessage): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    const blocks = message.message.content ?? [];
    const parent = message.parent_tool_use_id;
    const messageKey = message.message.id ?? message.uuid ?? "msg";
    blocks.forEach((block: ContentBlock) => {
      if (block.type === "text") {
        // Fallback path: without includePartialMessages the whole text lands here at once.
        if (this.#opts.partialMessages || parent !== null) return;
        const text = (block as { text?: string }).text;
        if (typeof text !== "string" || text === "") return;
        events.push({ type: "assistant.delta", messageKey, delta: text });
        return;
      }
      if (block.type === "thinking") {
        if (this.#opts.partialMessages || parent !== null) return;
        const thinking = (block as { thinking?: string }).thinking;
        if (typeof thinking !== "string" || thinking === "") return;
        events.push({ type: "assistant.reasoning", messageKey, delta: thinking });
        return;
      }
      if (block.type !== "tool_use") return;
      const tool = block as ToolUseBlock;
      const input = tool.input ?? {};
      const tracked: TrackedTool = { toolName: tool.name, input, parentToolUseId: parent };

      if (SUBAGENT_TOOLS.has(tool.name)) {
        const description = typeof input["description"] === "string" ? input["description"] : undefined;
        const subagentType = typeof input["subagent_type"] === "string" ? input["subagent_type"] : undefined;
        tracked.childName = description ?? subagentType ?? tool.name;
      }
      this.#tools.set(tool.id, tracked);

      events.push({
        type: "activity",
        activity: {
          kind: "tool",
          toolUseId: tool.id,
          toolName: tool.name,
          input,
          status: "running",
          ...(parent !== null ? { parentToolUseId: parent } : {}),
        },
      });

      if (tracked.childName !== undefined) {
        const subagentType = typeof input["subagent_type"] === "string" ? input["subagent_type"] : undefined;
        const known = this.#children.get(tool.id);
        this.#children.set(tool.id, {
          name: tracked.childName,
          ...(subagentType ? { description: subagentType } : {}),
          backgrounded: input["run_in_background"] === true || (known?.backgrounded ?? false),
          summarised: known?.summarised ?? false,
        });
        events.push({
          type: "activity",
          activity: {
            kind: "child",
            childKey: tool.id,
            name: tracked.childName,
            status: "running",
            ...(subagentType ? { description: subagentType } : {}),
            ...(parent !== null ? { parentToolUseId: parent } : {}),
          },
        });
      }

      if (tool.name === "TodoWrite") {
        const steps = planSteps(input);
        if (steps) events.push({ type: "plan.progress", steps });
      }
    });
    return events;
  }

  #user(message: UserMessage): NormalizedEvent[] {
    const content = message.message.content;
    const text = userText(content);
    if (text.includes("<task-notification>")) return this.#notificationMessage(text);
    if (!Array.isArray(content)) return [];
    const events: NormalizedEvent[] = [];
    for (const block of content) {
      if (block.type !== "tool_result") continue;
      const result = block as ToolResultBlock;
      const tracked = this.#tools.get(result.tool_use_id);
      const output = truncate(toolResultText(result));
      const status = result.is_error === true ? "error" : "ok";
      events.push({
        type: "activity",
        activity: {
          kind: "tool",
          toolUseId: result.tool_use_id,
          toolName: tracked?.toolName ?? "unknown",
          input: tracked?.input ?? {},
          status,
          ...(output !== "" ? { output } : {}),
          ...(tracked?.parentToolUseId ? { parentToolUseId: tracked.parentToolUseId } : {}),
        },
      });
      if (tracked?.childName !== undefined) events.push(...this.#subagentResult(result, tracked, status));
      this.#tools.delete(result.tool_use_id);
    }
    return events;
  }

  /**
   * The `Task`/`Agent` tool_result is the sub-agent's final report — unless the agent runs
   * in the background, when it is a placeholder and the row stays running until the
   * task_notification arrives.
   */
  #subagentResult(result: ToolResultBlock, tracked: TrackedTool, status: "ok" | "error"): NormalizedEvent[] {
    const childKey = result.tool_use_id;
    const full = toolResultText(result);
    const child = this.#children.get(childKey);
    if (status !== "error" && (child?.backgrounded === true || BACKGROUND_PLACEHOLDER.test(full.slice(0, 400)))) {
      if (child) child.backgrounded = true;
      const taskId = placeholderAgentId(full);
      if (taskId === undefined) return [];
      // the agent id is what its later task_notification names: record it on the row
      this.#taskChild.set(taskId, childKey);
      const name = child?.name ?? tracked.childName ?? "Background task";
      return [
        {
          type: "activity",
          activity: {
            kind: "child",
            childKey,
            taskId,
            name,
            status: "running",
            ...(child?.description ? { description: child.description } : {}),
            ...(tracked.parentToolUseId ? { parentToolUseId: tracked.parentToolUseId } : {}),
          },
        },
      ];
    }
    const report = full.trim() === "" ? undefined : capReport(full);
    const summary = report ? firstLine(report) : undefined;
    return this.#settleChild(childKey, status === "error" ? "error" : "done", {
      ...(report ? { report } : {}),
      ...(summary !== undefined ? { summary } : {}),
      parentToolUseId: tracked.parentToolUseId,
      ...(tracked.childName ? { fallbackName: tracked.childName } : {}),
    });
  }

  #result(message: ResultMessage): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    if (message.resume_reason) events.push(...this.#info(`Turn resumed after a restart (${message.resume_reason})`));
    if (message.startup_failure_reason) events.push(...this.#info(`Claude Code failed to start: ${message.startup_failure_reason}`));
    events.push({ type: "usage", usage: this.#usage.result(message) });

    if (this.#interrupted) {
      this.#interrupted = false;
      events.push({ type: "settled", status: "interrupted" });
      return events;
    }
    if (message.subtype === "success" && message.is_error !== true) {
      events.push({ type: "settled", status: "completed" });
      return events;
    }
    const error = message.errors?.join("; ") ?? message.result ?? message.subtype;
    events.push({ type: "settled", status: "error", error: truncate(error, 1000) });
    return events;
  }
}
