import type { NormalizedEvent } from "@tide/contracts";
import type {
  AssistantMessage,
  ClaudeMessage,
  ContentBlock,
  RateLimitInfoShape,
  RateLimitMessage,
  ResultMessage,
  StreamEventMessage,
  SystemInitMessage,
  SystemOtherMessage,
  ToolResultBlock,
  ToolUseBlock,
  UserMessage,
} from "./sdk-shapes.ts";

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
  "status", // per-request spinner state (requesting/…)
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
}

/** Cumulative per-`query()` figures from the previous `result`, to turn totals into per-turn deltas. */
interface Cumulative {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

/** Delta of two cumulative counters; a counter that went backwards (new query) restarts from zero. */
function delta(now: number, before: number): number {
  return now >= before ? now - before : now;
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
  #reported: Cumulative = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  unknownCount = 0;

  constructor(options: NormalizerOptions) {
    this.#opts = options;
  }

  /** Backgrounded sub-agents that have not reported yet (they keep Claude Code busy between turns). */
  backgroundCount(): number {
    let count = 0;
    for (const child of this.#children.values()) if (child.backgrounded && child.settled !== true) count++;
    return count;
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
    return known ?? /"([^"]+)"/.exec(tagText(text, "summary") ?? "")?.[1] ?? "background task";
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
      const trigger = other.compact_metadata?.trigger ?? "auto";
      return this.#info(`Context compacted (${trigger})`);
    }
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
      return [{ type: "activity", activity: { kind: "child", childKey, name, status: "running", ...(description ? { description } : {}) } }];
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
    const childKey = this.#taskChild.get(taskId) ?? message.tool_use_id ?? taskId;
    this.#tasks.delete(taskId);
    return this.#settleChild(childKey, message.status === "completed" ? "done" : "error", { ...(message.summary !== undefined ? { summary: message.summary } : {}), weak: true });
  }

  /** The final child update: status, optional report, and a summary only when none was shown. */
  #settleChild(childKey: string, status: "done" | "error", fields: { summary?: string; weak?: boolean; report?: string; parentToolUseId?: string | null; fallbackName?: string }): NormalizedEvent[] {
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
    const childKey = (taskId !== undefined ? this.#taskChild.get(taskId) : undefined) ?? toolUseId;
    if (childKey === undefined || !this.#children.has(childKey)) return [];
    const result = tagText(text, "result");
    const report = result ? capReport(result) : undefined;
    const statusText = tagText(text, "status");
    const status = statusText === undefined || statusText === "completed" ? "done" : "error";
    const summary = report ? firstLine(report) : tagText(text, "summary");
    return this.#settleChild(childKey, status, { ...(summary !== undefined ? { summary } : {}), ...(report ? { report } : {}) });
  }

  #rateLimit(message: RateLimitMessage): NormalizedEvent[] {
    const info = message.rate_limit_info;
    if (!info || info.status === undefined) return [];
    const nominal = info.status === "allowed";
    const used = usedFraction(info);
    const resets = info.rateLimitType ? info.unifiedWindows?.[info.rateLimitType]?.resetsAt : undefined;
    const resetsAt = info.resetsAt ?? resets;
    const overage = info.isUsingOverage ?? info.overageInUse;
    const status = nominal ? "ok" : info.status === "allowed_warning" ? "warning" : "limited";
    const note = `${info.rateLimitType ?? "rate limit"}${used !== undefined ? ` ${Math.round(used * 100)}% used` : ""}${info.status === "rejected" ? " (rejected)" : ""}`;
    const events: NormalizedEvent[] = [
      {
        type: "usage",
        rateLimit: {
          status,
          ...(used !== undefined ? { remainingPct: Math.max(0, Math.min(100, Math.round((1 - used) * 100))) } : {}),
          // the CLI reports epoch seconds; the contract's `at` is epoch ms, so resetsAt follows suit
          ...(typeof resetsAt === "number" ? { resetsAt: resetsAt * 1000 } : {}),
          ...(typeof overage === "boolean" ? { overage } : {}),
          note,
          at: (this.#opts.now ?? Date.now)(),
        },
      },
    ];
    // A nominal frame is per-request housekeeping: it feeds the gauge but earns no timeline row.
    if (!nominal) events.push(...this.#info(`Rate limit ${info.status}${info.rateLimitType ? ` on ${info.rateLimitType}` : ""}${used !== undefined ? ` (${Math.round(used * 100)}% used)` : ""}`));
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
      return [];
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
    // `usage` and `total_cost_usd` are cumulative for the whole query() (one per session);
    // the contract wants this turn's delta only.
    const usage = message.usage ?? {};
    const now: Cumulative = {
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cost: typeof message.total_cost_usd === "number" ? message.total_cost_usd : this.#reported.cost,
    };
    const before = this.#reported;
    this.#reported = now;
    const cost = delta(now.cost, before.cost);
    const events: NormalizedEvent[] = [];
    if (message.resume_reason) events.push(...this.#info(`Turn resumed after a restart (${message.resume_reason})`));
    if (message.startup_failure_reason) events.push(...this.#info(`Claude Code failed to start: ${message.startup_failure_reason}`));
    events.push({
      type: "usage",
      usage: {
        inputTokens: delta(now.input, before.input),
        outputTokens: delta(now.output, before.output),
        ...(typeof usage.cache_read_input_tokens === "number" ? { cacheReadTokens: delta(now.cacheRead, before.cacheRead) } : {}),
        ...(typeof usage.cache_creation_input_tokens === "number" ? { cacheWriteTokens: delta(now.cacheWrite, before.cacheWrite) } : {}),
        ...(typeof message.total_cost_usd === "number" ? { costUsd: Math.round(cost * 1e8) / 1e8 } : {}),
      },
    });

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

/** Used share of the window, 0..1. The CLI reports fractions (0.18); a stray >1 value is read as percent. */
function usedFraction(info: RateLimitInfoShape): number | undefined {
  const raw = info.utilization ?? (info.rateLimitType ? info.unifiedWindows?.[info.rateLimitType]?.utilization : undefined);
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  return raw > 1 ? raw / 100 : raw;
}
