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
      case "agent_start":
      case "agent_end":
      case "turn_start":
      case "turn_end":
      case "queue_update":
      case "tool_execution_update":
      case "auto_retry_end":
      case "bash_execution_update":
        return [];
      default:
        this.unknownCount += 1;
        this.#options.onUnknown?.(event.type);
        return [];
    }
  }

  #messageUpdate(event: PiEvent): NormalizedEvent[] {
    const delta = event["assistantMessageEvent"];
    if (typeof delta !== "object" || delta === null) return [];
    const record = delta as Record<string, unknown>;
    // thinking_* and toolcall_* deltas are deliberately dropped: thinking never belongs in the
    // assistant message, and tool calls arrive whole on tool_execution_start.
    if (record["type"] !== "text_delta") return [];
    const text = str(record["delta"]);
    if (text === undefined || text === "") return [];
    const index = typeof record["contentIndex"] === "number" ? record["contentIndex"] : 0;
    return [{ type: "assistant.delta", messageKey: `pi-${this.#messageSeq}-${index}`, delta: text }];
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
