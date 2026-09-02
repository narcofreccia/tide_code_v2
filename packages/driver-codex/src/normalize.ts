import type { NormalizedEvent } from "@tide/contracts";
import { toolActivity, toolShape, truncate } from "./items.ts";
import type { ItemCompletedNotification } from "./generated/v2/ItemCompletedNotification.ts";
import type { ItemStartedNotification } from "./generated/v2/ItemStartedNotification.ts";
import type { ThreadItem } from "./generated/v2/ThreadItem.ts";
import type { ThreadTokenUsageUpdatedNotification } from "./generated/v2/ThreadTokenUsageUpdatedNotification.ts";
import type { TurnCompletedNotification } from "./generated/v2/TurnCompletedNotification.ts";

const MAX_PAYLOAD_CHARS = 4096;

/**
 * The only notifications dropped without a trace (CLAUDE.md §1a: unmodelled events are
 * passed through generically, not swallowed). Each of these is state Tide already tracks
 * or renders elsewhere, so a row would be pure duplication.
 */
export const CODEX_SILENT_NOTIFICATIONS = new Set([
  "thread/status/changed", // idle/busy — the turn lifecycle already says this
  "thread/settings/updated", // echo of what Tide itself just sent on turn/start
  "serverRequest/resolved", // the approval card already shows the decision
  "turn/diff/updated", // the checkpoint diff is computed from git, not from this
  "remoteControl/status/changed", // Codex's own remote-control channel, unused by Tide
]);

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

export interface NormalizerOptions {
  /** the thread this session drives; notifications for other threads are ignored unless they are its collab children */
  threadId?: string;
  /** called for notifications the normalizer does not model; never throws */
  onUnknown?: (method: string) => void;
}

interface Delta {
  itemId: string;
  text: string;
}

/**
 * Stateful but I/O-free translator from `codex app-server` notifications to
 * `NormalizedEvent`s. State is only what the stream cannot repeat: aggregated output and
 * plan deltas, the ids that already streamed text, and the collab child threads whose rows
 * must be stamped with a `parentToolUseId`.
 */
export class CodexNormalizer {
  #options: NormalizerOptions;
  #threadId: string | undefined;
  /** child threadId -> the collab tool-call item that spawned it */
  #children = new Map<string, string>();
  #commandOutput = new Map<string, string>();
  #planText = new Map<string, string>();
  #streamedMessages = new Set<string>();
  /**
   * Codex reasoning and the agent message that follows it are *separate items*, so the
   * message key cannot be the item id. Instead a turn has message "slots": reasoning goes
   * to the open slot, the next agentMessage claims that slot, and completing that message
   * opens a new one — so reasoning merges into the message it precedes while two agent
   * messages in one turn still stay apart.
   */
  #slot = 0;
  #messageKeys = new Map<string, string>();
  #patches = new Map<string, string>();
  #interrupted = false;
  /** the turn currently running, needed by `turn/interrupt` */
  turnId: string | undefined;
  unknownCount = 0;

  constructor(options: NormalizerOptions = {}) {
    this.#options = options;
    this.#threadId = options.threadId;
  }

  /** Marks the turn as user-interrupted so `turn/completed` settles as `interrupted`. */
  markInterrupted(): void {
    this.#interrupted = true;
  }

  /** Diff last reported for a file-change item; used to enrich its approval request. */
  patchFor(itemId: string): string | undefined {
    return this.#patches.get(itemId);
  }

  next(method: string, params: unknown): NormalizedEvent[] {
    const payload = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    const threadId = typeof payload["threadId"] === "string" ? payload["threadId"] : undefined;
    if (method === "thread/started") return this.#threadStarted(payload);
    if (threadId !== undefined && this.#threadId !== undefined && threadId !== this.#threadId && !this.#children.has(threadId)) return [];
    const parent = threadId !== undefined ? this.#children.get(threadId) : undefined;

    switch (method) {
      case "turn/started":
        this.turnId = (payload["turn"] as { id?: string } | undefined)?.id;
        this.#slot = 0;
        this.#messageKeys.clear();
        return [];
      case "item/agentMessage/delta":
        return this.#messageDelta(payload, parent);
      case "item/plan/delta":
        return this.#planDelta(payload);
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta":
        return this.#reasoningDelta(payload, parent);
      case "item/reasoning/summaryPartAdded":
        return []; // a section break inside the reasoning stream, no text of its own
      case "item/commandExecution/outputDelta":
      case "item/fileChange/outputDelta":
        return this.#outputDelta(payload);
      case "item/fileChange/patchUpdated":
        return this.#patchUpdated(payload);
      case "item/started":
        return this.#item((payload as unknown as ItemStartedNotification).item, false, parent);
      case "item/completed":
        return this.#item((payload as unknown as ItemCompletedNotification).item, true, parent);
      case "turn/plan/updated":
        return this.#planProgress(payload);
      case "thread/tokenUsage/updated":
        return this.#usage(payload as unknown as ThreadTokenUsageUpdatedNotification);
      case "turn/completed":
        return this.#turnCompleted(payload as unknown as TurnCompletedNotification);
      case "error":
        return this.#error(payload);
      case "model/rerouted":
        return this.#info(`Model rerouted from ${String(payload["fromModel"])} to ${String(payload["toModel"])} (${String(payload["reason"])})`);
      case "thread/compacted":
        return this.#info("Context compacted");
      case "warning":
      case "guardianWarning":
        return this.#info(truncate(String(payload["message"] ?? "warning"), 500));
      default:
        if (CODEX_SILENT_NOTIFICATIONS.has(method)) return [];
        this.unknownCount++;
        this.#options.onUnknown?.(method);
        // Pass through, don't translate (CLAUDE.md §1a): the row appears generically with
        // the raw notification attached rather than vanishing.
        return [{ type: "activity", activity: { kind: "info", text: `codex: ${method}`, payload: rawPayload(params) } }];
    }
  }

  /** The key every message-scoped event of the currently open slot shares. */
  #slotKey(): string {
    return `${this.turnId ?? "turn"}#${this.#slot}`;
  }

  /** An agentMessage item claims the open slot the reasoning before it was written to. */
  #keyForMessage(itemId: string): string {
    const existing = this.#messageKeys.get(itemId);
    if (existing !== undefined) return existing;
    const key = this.#slotKey();
    this.#messageKeys.set(itemId, key);
    return key;
  }

  #info(text: string, kind: "info" | "error" = "info"): NormalizedEvent[] {
    return [{ type: "activity", activity: { kind, text } }];
  }

  #threadStarted(payload: Record<string, unknown>): NormalizedEvent[] {
    const thread = payload["thread"] as { id?: string; parentThreadId?: string | null } | undefined;
    const id = thread?.id;
    if (typeof id !== "string") return [];
    // A collab child announces itself with our thread as its parent.
    if (this.#threadId !== undefined && id !== this.#threadId) {
      if (thread?.parentThreadId === this.#threadId) this.#children.set(id, this.#children.get(id) ?? id);
      return [];
    }
    this.#threadId ??= id;
    return [{ type: "session", nativeSessionId: id }];
  }

  #delta(payload: Record<string, unknown>): Delta | undefined {
    const itemId = payload["itemId"];
    const text = payload["delta"];
    if (typeof itemId !== "string" || typeof text !== "string" || text === "") return undefined;
    return { itemId, text };
  }

  #messageDelta(payload: Record<string, unknown>, parent: string | undefined): NormalizedEvent[] {
    const delta = this.#delta(payload);
    if (!delta) return [];
    // A sub-agent's prose belongs to its child row, not to the main assistant message.
    if (parent !== undefined) return [];
    this.#streamedMessages.add(delta.itemId);
    return [{ type: "assistant.delta", messageKey: this.#keyForMessage(delta.itemId), delta: delta.text }];
  }

  #reasoningDelta(payload: Record<string, unknown>, parent: string | undefined): NormalizedEvent[] {
    const delta = this.#delta(payload);
    if (!delta || parent !== undefined) return [];
    return [{ type: "assistant.reasoning", messageKey: this.#slotKey(), delta: delta.text }];
  }

  #planDelta(payload: Record<string, unknown>): NormalizedEvent[] {
    const delta = this.#delta(payload);
    if (!delta) return [];
    this.#planText.set(delta.itemId, (this.#planText.get(delta.itemId) ?? "") + delta.text);
    return [];
  }

  #outputDelta(payload: Record<string, unknown>): NormalizedEvent[] {
    const delta = this.#delta(payload);
    if (!delta) return [];
    const previous = this.#commandOutput.get(delta.itemId) ?? "";
    // Cap the buffer: the activity only ever shows a truncated head.
    this.#commandOutput.set(delta.itemId, previous.length > 64_000 ? previous : previous + delta.text);
    return [];
  }

  #patchUpdated(payload: Record<string, unknown>): NormalizedEvent[] {
    const itemId = payload["itemId"];
    const changes = payload["changes"];
    if (typeof itemId !== "string" || !Array.isArray(changes)) return [];
    const diff = changes.map((change) => String((change as { diff?: unknown }).diff ?? "")).join("\n");
    this.#patches.set(itemId, diff);
    return [];
  }

  #item(item: ThreadItem | undefined, completed: boolean, parent: string | undefined): NormalizedEvent[] {
    if (!item) return [];
    if (item.type === "plan") return completed ? this.#planProposed(item.id, item.text) : [];
    if (item.type === "agentMessage") return completed ? this.#agentMessage(item, parent) : [];
    if (item.type === "collabAgentToolCall") return this.#collab(item, parent);
    if (item.type === "subAgentActivity") return this.#subAgent(item, parent);

    const shape = toolShape(item, this.#commandOutput.get((item as { id?: string }).id ?? ""));
    if (!shape) return [];
    if (completed) this.#commandOutput.delete(shape.toolUseId);
    return [{ type: "activity", activity: toolActivity(shape, parent) }];
  }

  #planProposed(itemId: string, text: string): NormalizedEvent[] {
    const markdown = text !== "" ? text : (this.#planText.get(itemId) ?? "");
    this.#planText.delete(itemId);
    return markdown === "" ? [] : [{ type: "plan.proposed", markdown }];
  }

  #agentMessage(item: Extract<ThreadItem, { type: "agentMessage" }>, parent: string | undefined): NormalizedEvent[] {
    if (parent !== undefined) return [];
    const key = this.#keyForMessage(item.id);
    const streamed = this.#streamedMessages.delete(item.id);
    // A completed message closes its slot: reasoning that follows belongs to the next one.
    this.#slot++;
    // Fallback for servers/turns that send no deltas: emit the finished text once.
    if (streamed || item.text === "") return [];
    return [{ type: "assistant.delta", messageKey: key, delta: item.text }];
  }

  #collab(item: Extract<ThreadItem, { type: "collabAgentToolCall" }>, parent: string | undefined): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    for (const child of item.receiverThreadIds.length > 0 ? item.receiverThreadIds : [item.id]) {
      this.#children.set(child, item.id);
      const state = item.agentsStates[child];
      events.push({
        type: "activity",
        activity: {
          kind: "child",
          childKey: child,
          name: item.tool,
          status: item.status === "inProgress" ? "running" : item.status === "failed" ? "error" : "done",
          childThreadId: child,
          ...(item.prompt ? { description: truncate(item.prompt, 500) } : {}),
          ...(state?.message ? { summary: truncate(state.message, 1000) } : {}),
          ...(parent !== undefined ? { parentToolUseId: parent } : {}),
        },
      });
    }
    return events;
  }

  #subAgent(item: Extract<ThreadItem, { type: "subAgentActivity" }>, parent: string | undefined): NormalizedEvent[] {
    this.#children.set(item.agentThreadId, this.#children.get(item.agentThreadId) ?? item.id);
    return [
      {
        type: "activity",
        activity: {
          kind: "child",
          childKey: item.agentThreadId,
          name: item.agentPath,
          status: item.kind === "started" ? "running" : item.kind === "interrupted" ? "error" : "done",
          childThreadId: item.agentThreadId,
          ...(parent !== undefined ? { parentToolUseId: parent } : {}),
        },
      },
    ];
  }

  #planProgress(payload: Record<string, unknown>): NormalizedEvent[] {
    const plan = payload["plan"];
    if (!Array.isArray(plan)) return [];
    const steps = plan.flatMap((raw) => {
      const step = raw as { step?: unknown; status?: unknown };
      if (typeof step.step !== "string") return [];
      const status: "pending" | "in_progress" | "completed" = step.status === "inProgress" ? "in_progress" : step.status === "completed" ? "completed" : "pending";
      return [{ text: step.step, status }];
    });
    return steps.length > 0 ? [{ type: "plan.progress", steps }] : [];
  }

  #usage(notification: ThreadTokenUsageUpdatedNotification): NormalizedEvent[] {
    const usage = notification.tokenUsage;
    if (!usage) return [];
    const last = usage.last;
    const window = usage.modelContextWindow;
    return [
      {
        type: "usage",
        usage: {
          inputTokens: last.inputTokens,
          outputTokens: last.outputTokens,
          cacheReadTokens: last.cachedInputTokens,
          cacheWriteTokens: last.cacheWriteInputTokens,
        },
        ...(typeof window === "number" && window > 0 ? { contextUsage: { used: usage.total.totalTokens, window } } : {}),
      },
    ];
  }

  #turnCompleted(notification: TurnCompletedNotification): NormalizedEvent[] {
    const turn = notification.turn;
    this.turnId = undefined;
    if (this.#interrupted) {
      this.#interrupted = false;
      return [{ type: "settled", status: "interrupted" }];
    }
    if (turn?.status === "interrupted") return [{ type: "settled", status: "interrupted" }];
    if (turn?.status === "completed") return [{ type: "settled", status: "completed" }];
    const error = turn?.error?.message ?? `turn ${turn?.status ?? "failed"}`;
    return [{ type: "settled", status: "error", error: truncate(error, 1000) }];
  }

  #error(payload: Record<string, unknown>): NormalizedEvent[] {
    const error = payload["error"] as { message?: unknown } | undefined;
    const message = truncate(String(error?.message ?? "codex error"), 500);
    // Retries are chatter; only the terminal failure is worth an error row.
    return this.#info(message, payload["willRetry"] === true ? "info" : "error");
  }
}
