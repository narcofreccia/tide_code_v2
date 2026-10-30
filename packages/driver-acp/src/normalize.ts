import type { DriverActivity, NormalizedEvent, SlashCommandInfo } from "@tide/contracts";
import { unifiedDiff } from "./diff.ts";
import type { AcpContentBlock, AcpToolCall, AcpToolContent, AcpSessionUpdate } from "./types.ts";

/**
 * `session/update` → NormalizedEvent. Pure state machine over one session; the session drives
 * `beginTurn()` and the load-replay mute. Unknown `sessionUpdate` variants pass through as an
 * `info` activity carrying the raw payload (CLAUDE.md §1a).
 */

const MAX_OUTPUT = 4000;

export function truncate(text: string, max = MAX_OUTPUT): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… (${text.length - max} more characters)`;
}

/** Updates that carry nothing a Tide turn shows. */
export const ACP_SILENT_UPDATES = new Set(["session_info_update", "config_option_update", "user_message_chunk"]);

function contentText(block: AcpContentBlock | undefined): string | undefined {
  if (!block) return undefined;
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "resource_link") return `[${block.name ?? block.uri ?? "resource"}]`;
  if (block.type === "resource") {
    const resource = block["resource"] as { text?: unknown; uri?: unknown } | undefined;
    return typeof resource?.text === "string" ? resource.text : typeof resource?.uri === "string" ? `[${resource.uri}]` : undefined;
  }
  return `[${block.type}]`;
}

function stringify(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** A text rendering of what the tool produced: content blocks first, `rawOutput` otherwise. */
export function toolOutput(call: AcpToolCall): string | undefined {
  const parts: string[] = [];
  for (const item of call.content ?? []) {
    if (item.type === "content") {
      const text = contentText(item.content);
      if (text) parts.push(text);
    } else if (item.type === "diff") {
      parts.push(unifiedDiff(item.path, item.oldText ?? "", item.newText) ?? `edited ${item.path}`);
    } else if (item.type === "terminal") {
      parts.push(`[terminal ${item.terminalId}]`);
    }
  }
  const text = parts.length > 0 ? parts.join("\n") : stringify(call.rawOutput);
  return text === undefined || text === "" ? undefined : truncate(text);
}

/** The first diff the tool carries, as a unified diff (approval previews). */
export function toolDiff(content: AcpToolContent[] | null | undefined): string | undefined {
  const diffs = (content ?? []).flatMap((item) => (item.type === "diff" ? [unifiedDiff(item.path, item.oldText ?? "", item.newText)] : []));
  const joined = diffs.filter((diff): diff is string => typeof diff === "string").join("\n");
  return joined === "" ? undefined : truncate(joined, 20_000);
}

export function toolName(call: Pick<AcpToolCall, "name" | "title" | "kind">): string {
  return call.name ?? call.title ?? call.kind ?? "tool";
}

export function toolInput(call: AcpToolCall): unknown {
  if (call.rawInput !== undefined && call.rawInput !== null) return call.rawInput;
  return { title: call.title ?? undefined, kind: call.kind ?? undefined, locations: call.locations ?? undefined };
}

function toolStatus(status: AcpToolCall["status"]): "running" | "ok" | "error" {
  if (status === "completed") return "ok";
  if (status === "failed") return "error";
  return "running";
}

function planStatus(status: unknown): "pending" | "in_progress" | "completed" {
  return status === "in_progress" || status === "completed" ? status : "pending";
}

export function toSlashCommands(list: unknown): SlashCommandInfo[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    const command = entry as { name?: unknown; description?: unknown; input?: { hint?: unknown } | null };
    if (typeof command.name !== "string" || command.name === "") return [];
    return [
      {
        name: command.name,
        source: "custom" as const,
        ...(typeof command.description === "string" && command.description !== "" ? { description: command.description } : {}),
        ...(typeof command.input?.hint === "string" ? { argumentHint: command.input.hint } : {}),
      },
    ];
  });
}

export interface NormalizerHooks {
  /** latest slash-command list, for `listCommands` */
  onCommands?: (commands: SlashCommandInfo[]) => void;
  /** the agent switched its own mode */
  onModeChange?: (modeId: string) => void;
}

export class AcpNormalizer {
  #hooks: NormalizerHooks;
  #turn = 0;
  #segment = 0;
  #segmentHasText = false;
  #tools = new Map<string, AcpToolCall>();
  /** assistant text per message key, in order (plan emulation reads the last one) */
  #texts = new Map<string, string>();
  /** `session/load` replays history as updates; none of it belongs to a live turn */
  muted = false;
  /** last cumulative session cost (USD) seen in `usage_update`; undefined = no baseline yet */
  #costSeen: number | undefined;
  #turnCost = 0;
  /** a resumed session's first cost report is history, not this turn */
  costBaselineUnknown = false;

  constructor(hooks: NormalizerHooks = {}) {
    this.#hooks = hooks;
  }

  beginTurn(): void {
    this.#turn += 1;
    this.#segment = 0;
    this.#segmentHasText = false;
    this.#texts.clear();
    this.#tools.clear();
    this.#turnCost = 0;
  }

  /** USD spent in this turn, from the deltas of `usage_update.cost` (cumulative per session). */
  get turnCost(): number {
    return this.#turnCost;
  }

  get messageKey(): string {
    return `acp-${this.#turn}#${this.#segment}`;
  }

  /** The turn's final assistant message (non-empty), for plan-mode emulation. */
  lastText(): string | undefined {
    return [...this.#texts.values()].filter((text) => text.trim() !== "").at(-1);
  }

  next(update: AcpSessionUpdate): NormalizedEvent[] {
    const kind = update.sessionUpdate;
    // state that must survive a replay: commands and mode; everything else is history
    if (kind === "available_commands_update") {
      const commands = toSlashCommands(update["availableCommands"]);
      this.#hooks.onCommands?.(commands);
      return this.muted ? [] : [{ type: "commands", commands }];
    }
    if (kind === "current_mode_update") {
      const modeId = typeof update["currentModeId"] === "string" ? update["currentModeId"] : undefined;
      if (modeId) this.#hooks.onModeChange?.(modeId);
      return this.muted || !modeId ? [] : [{ type: "activity", activity: { kind: "info", text: `Mode: ${modeId}` } }];
    }
    if (this.muted) return [];
    switch (kind) {
      case "agent_message_chunk":
        return this.#text(update["content"] as AcpContentBlock | undefined, "assistant.delta");
      case "agent_thought_chunk":
        return this.#text(update["content"] as AcpContentBlock | undefined, "assistant.reasoning");
      case "tool_call":
        return this.#tool(update as unknown as AcpToolCall, true);
      case "tool_call_update":
        return this.#tool(update as unknown as AcpToolCall, false);
      case "plan":
        return this.#plan(update["entries"]);
      case "usage_update":
        return this.#usage(update);
      default:
        if (ACP_SILENT_UPDATES.has(kind)) return [];
        return [{ type: "activity", activity: { kind: "info", text: kind, payload: update } }];
    }
  }

  #text(block: AcpContentBlock | undefined, type: "assistant.delta" | "assistant.reasoning"): NormalizedEvent[] {
    const delta = block?.type === "text" ? block.text : contentText(block);
    if (delta === undefined || delta === "") return [];
    const messageKey = this.messageKey;
    this.#segmentHasText = true;
    if (type === "assistant.delta") {
      this.#texts.set(messageKey, (this.#texts.get(messageKey) ?? "") + delta);
    }
    return [{ type, messageKey, delta }];
  }

  #tool(patch: AcpToolCall, created: boolean): NormalizedEvent[] {
    if (typeof patch.toolCallId !== "string") return [];
    // text or reasoning after a tool call is a new assistant message, like the other drivers render it
    if (this.#segmentHasText) {
      this.#segment += 1;
      this.#segmentHasText = false;
    }
    const previous = created ? undefined : this.#tools.get(patch.toolCallId);
    const merged: AcpToolCall = { ...previous, toolCallId: patch.toolCallId };
    for (const [key, value] of Object.entries(patch)) {
      if (key === "sessionUpdate" || value === undefined || value === null) continue;
      (merged as unknown as Record<string, unknown>)[key] = value;
    }
    this.#tools.set(patch.toolCallId, merged);
    return [{ type: "activity", activity: this.toolActivity(merged) }];
  }

  toolActivity(call: AcpToolCall): DriverActivity {
    const output = toolOutput(call);
    return {
      kind: "tool",
      toolUseId: call.toolCallId,
      toolName: toolName(call),
      input: toolInput(call),
      status: toolStatus(call.status),
      ...(output !== undefined ? { output } : {}),
    };
  }

  /** The merged state of a tool call seen this turn (permission requests carry only a patch). */
  tool(toolCallId: string): AcpToolCall | undefined {
    return this.#tools.get(toolCallId);
  }

  #plan(entries: unknown): NormalizedEvent[] {
    if (!Array.isArray(entries)) return [];
    const steps = entries.flatMap((entry) => {
      const item = entry as { content?: unknown; status?: unknown };
      return typeof item.content === "string" ? [{ text: item.content, status: planStatus(item.status) }] : [];
    });
    return [{ type: "plan.progress", steps }];
  }

  #usage(update: AcpSessionUpdate): NormalizedEvent[] {
    const cost = update["cost"] as { amount?: unknown; currency?: unknown } | null | undefined;
    if (cost && typeof cost.amount === "number" && cost.currency === "USD") {
      if (this.#costSeen === undefined && this.costBaselineUnknown) this.#costSeen = cost.amount;
      this.#turnCost += Math.max(0, cost.amount - (this.#costSeen ?? 0));
      this.#costSeen = cost.amount;
    }
    const used = update["used"];
    const size = update["size"];
    if (typeof used !== "number" || typeof size !== "number" || size <= 0) return [];
    return [{ type: "usage", contextUsage: { used, window: size } }];
  }
}
