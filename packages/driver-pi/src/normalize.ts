import type { NormalizedEvent } from "@tide/contracts";
import type { PiEvent } from "./types.ts";

/**
 * pi agent events → Tide's normalized vocabulary. Event names are the ones listed in
 * docs/rpc.md § Events of @earendil-works/pi-coding-agent 0.84.x:
 *   message_start / message_update / message_end, tool_execution_start / _end,
 *   agent_start / agent_end / agent_settled, compaction_start / _end, extension_error.
 *
 * `agent_end` is NOT the end of a turn — pi may still retry, compact, or drain queued
 * messages — so the turn settles on `agent_settled`.
 *
 * Extension UI lines (approvals, plan, usage) are handled by approvals.ts, not here.
 */

const MAX_OUTPUT = 4000;
const MAX_PAYLOAD = 4096;

/**
 * The only pi events Tide drops silently: pure lifecycle bookkeeping with no user-visible
 * content. Everything else — known-but-unmodelled and outright unknown frames alike — is
 * passed through as a generic info activity (CLAUDE.md §1a: pass through, don't drop).
 */
// tool_execution_update / bash_execution_update are per-output-chunk streaming frames whose
// content arrives whole on tool_execution_end: passing them through would emit one info activity
// per chunk, which is duplication rather than an unmodelled event.
export const PI_SILENT_EVENTS: ReadonlySet<string> = new Set(["agent_start", "agent_end", "queue_update", "tool_execution_update", "bash_execution_update"]);

/** The raw event for the generic renderer; oversized frames degrade to a truncated JSON string. */
function rawPayload(event: PiEvent): unknown {
  let json: string;
  try {
    json = JSON.stringify(event) ?? "";
  } catch {
    return `<unserializable ${event.type} event>`;
  }
  if (json.length <= MAX_PAYLOAD) return event;
  return `${json.slice(0, MAX_PAYLOAD)}… (${json.length - MAX_PAYLOAD} more characters)`;
}

/** Generic card for a pi event Tide has no model for. */
function passThrough(event: PiEvent): NormalizedEvent[] {
  return [{ type: "activity", activity: { kind: "info", text: `pi: ${event.type}`, payload: rawPayload(event) } }];
}

export function truncate(text: string, max = MAX_OUTPUT): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

interface PiContentBlock {
  type?: string;
  text?: string;
}

function renderContent(content: unknown): string | undefined {
  if (typeof content === "string") return truncate(content);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .flatMap((block) => (typeof block === "object" && block !== null && (block as PiContentBlock).type === "text" ? [(block as PiContentBlock).text ?? ""] : []))
    .join("\n")
    .trim();
  return text === "" ? undefined : truncate(text);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export interface PiNormalizerOptions {
  onUnknown?: (type: string) => void;
}

export class PiNormalizer {
  #options: PiNormalizerOptions;
  #messageSeq = 0;
  #interrupted = false;
  #stopReason: string | undefined;
  #errorMessage: string | undefined;
  unknownCount = 0;

  constructor(options: PiNormalizerOptions = {}) {
    this.#options = options;
  }

  markInterrupted(): void {
    this.#interrupted = true;
  }

  /** Resets per-turn state; called by the session before each `prompt`. */
  beginTurn(): void {
    this.#interrupted = false;
    this.#stopReason = undefined;
    this.#errorMessage = undefined;
  }

  next(event: PiEvent): NormalizedEvent[] {
    switch (event.type) {
      case "message_start":
        this.#messageSeq += 1;
        return [];
      case "message_update":
        return this.#messageUpdate(event);
      case "message_end":
        return this.#messageEnd(event);
      case "tool_execution_start":
        return this.#toolStart(event);
      case "tool_execution_end":
        return this.#toolEnd(event);
      case "agent_settled":
        return [this.#settled()];
      case "compaction_start":
        return [{ type: "activity", activity: { kind: "info", text: `Compacting context (${str(event["reason"]) ?? "manual"})` } }];
      case "compaction_end":
        return [{ type: "activity", activity: { kind: "info", text: "Context compacted" } }];
      case "auto_retry_start":
        return [{ type: "activity", activity: { kind: "info", text: `Retrying after a transient error: ${str(event["errorMessage"]) ?? "unknown"}` } }];
      case "extension_error":
        return [{ type: "activity", activity: { kind: "error", text: `Extension error (${str(event["event"]) ?? "?"}): ${str(event["error"]) ?? "unknown"}` } }];
      default:
        if (PI_SILENT_EVENTS.has(event.type)) return [];
        // Known-but-unmodelled frames (turn_start/_end, auto_retry_end, …) and frames from a
        // newer pi both land here.
        this.unknownCount += 1;
        this.#options.onUnknown?.(event.type);
        return passThrough(event);
    }
  }

  #messageUpdate(event: PiEvent): NormalizedEvent[] {
    const delta = event["assistantMessageEvent"];
    if (typeof delta !== "object" || delta === null) return [];
    const record = delta as Record<string, unknown>;
    // toolcall_* deltas are dropped: tool calls arrive whole on tool_execution_start.
    // text_delta and thinking_delta share one message-scoped key (never the contentIndex, which
    // differs per content block) so reasoning merges into the message its text belongs to.
    const kind = record["type"];
    if (kind !== "text_delta" && kind !== "thinking_delta") return [];
    const text = str(record["delta"]);
    if (text === undefined || text === "") return [];
    const messageKey = `pi-${this.#messageSeq}`;
    return [kind === "thinking_delta" ? { type: "assistant.reasoning", messageKey, delta: text } : { type: "assistant.delta", messageKey, delta: text }];
  }

  #messageEnd(event: PiEvent): NormalizedEvent[] {
    const message = event["message"];
    if (typeof message !== "object" || message === null) return [];
    const record = message as Record<string, unknown>;
    if (record["role"] !== "assistant") return [];
    this.#stopReason = str(record["stopReason"]);
    this.#errorMessage = str(record["errorMessage"]);
    return [];
  }

  #toolStart(event: PiEvent): NormalizedEvent[] {
    const toolUseId = str(event["toolCallId"]);
    const toolName = str(event["toolName"]);
    if (!toolUseId || !toolName) return [];
    return [{ type: "activity", activity: { kind: "tool", toolUseId, toolName, input: event["args"] ?? {}, status: "running" } }];
  }

  #toolEnd(event: PiEvent): NormalizedEvent[] {
    const toolUseId = str(event["toolCallId"]);
    const toolName = str(event["toolName"]);
    if (!toolUseId || !toolName) return [];
    const result = event["result"];
    const output = typeof result === "object" && result !== null ? renderContent((result as Record<string, unknown>)["content"]) : undefined;
    return [
      {
        type: "activity",
        activity: {
          kind: "tool",
          toolUseId,
          toolName,
          input: event["args"] ?? {},
          status: event["isError"] === true ? "error" : "ok",
          ...(output ? { output } : {}),
        },
      },
    ];
  }

  #settled(): NormalizedEvent {
    if (this.#interrupted || this.#stopReason === "aborted") return { type: "settled", status: "interrupted" };
    if (this.#stopReason === "error") {
      return { type: "settled", status: "error", error: this.#errorMessage ?? "pi reported an error" };
    }
    return { type: "settled", status: "completed" };
  }
}
