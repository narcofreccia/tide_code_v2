import type { DriverActivity } from "@tide/contracts";
import type { ThreadItem } from "./generated/v2/ThreadItem.ts";

const MAX_OUTPUT_CHARS = 4096;

export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

export type ToolStatus = "running" | "ok" | "error";

/** Codex reports four per-item status vocabularies; they collapse onto three Tide states. */
export function toolStatus(status: string | null | undefined): ToolStatus {
  if (status === "inProgress" || status === undefined || status === null) return "running";
  if (status === "completed") return "ok";
  return "error";
}

function jsonText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

function mcpOutput(item: Extract<ThreadItem, { type: "mcpToolCall" }>): string {
  if (item.error) return item.error.message;
  const content = item.result?.content;
  if (!Array.isArray(content)) return jsonText(item.result?.structuredContent);
  return content
    .map((part) => (typeof part === "object" && part !== null && "text" in part ? String((part as { text?: unknown }).text ?? "") : jsonText(part)))
    .filter((part) => part !== "")
    .join("\n");
}

function dynamicOutput(item: Extract<ThreadItem, { type: "dynamicToolCall" }>): string {
  return (item.contentItems ?? [])
    .map((part) => (part.type === "inputText" ? part.text : part.type === "inputImage" ? `[image ${part.imageUrl}]` : `[audio ${part.audioUrl}]`))
    .join("\n");
}

export interface ToolShape {
  toolUseId: string;
  toolName: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
  durationMs?: number;
}

/**
 * Maps one Codex `ThreadItem` onto a Tide tool activity, or `undefined` for items that are
 * not tool calls (messages, reasoning, plan, collab — handled by the normalizer).
 * `extraOutput` carries text aggregated from the item outputDelta notifications.
 */
export function toolShape(item: ThreadItem, extraOutput?: string): ToolShape | undefined {
  switch (item.type) {
    case "commandExecution": {
      const output = item.aggregatedOutput ?? extraOutput ?? "";
      return {
        toolUseId: item.id,
        toolName: "Bash",
        input: { command: item.command, cwd: item.cwd, ...(item.exitCode !== null ? { exitCode: item.exitCode } : {}) },
        status: toolStatus(item.status),
        ...(output !== "" ? { output: truncate(output) } : {}),
        ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}),
      };
    }
    case "fileChange": {
      const diff = item.changes.map((change) => change.diff).join("\n");
      return {
        toolUseId: item.id,
        toolName: "Edit",
        input: { changes: item.changes.map((change) => ({ path: change.path, kind: change.kind.type })) },
        status: toolStatus(item.status),
        ...(diff !== "" ? { output: truncate(diff) } : {}),
      };
    }
    case "mcpToolCall": {
      const output = mcpOutput(item);
      return {
        toolUseId: item.id,
        toolName: `mcp:${item.server}.${item.tool}`,
        input: item.arguments,
        status: toolStatus(item.status),
        ...(output !== "" ? { output: truncate(output) } : {}),
        ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}),
      };
    }
    case "dynamicToolCall": {
      const output = dynamicOutput(item);
      return {
        toolUseId: item.id,
        toolName: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
        input: item.arguments,
        status: item.status === "inProgress" ? "running" : item.success === false ? "error" : toolStatus(item.status),
        ...(output !== "" ? { output: truncate(output) } : {}),
        ...(item.durationMs !== null ? { durationMs: item.durationMs } : {}),
      };
    }
    case "webSearch":
      return { toolUseId: item.id, toolName: "WebSearch", input: { query: item.query }, status: item.results === null ? "running" : "ok" };
    case "imageGeneration":
      return { toolUseId: item.id, toolName: "ImageGeneration", input: { prompt: item.revisedPrompt }, status: toolStatus(item.status) };
    default:
      return undefined;
  }
}

export function toolActivity(shape: ToolShape, parentToolUseId?: string): DriverActivity {
  return { kind: "tool", ...shape, ...(parentToolUseId !== undefined ? { parentToolUseId } : {}) };
}
