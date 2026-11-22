import type { DriverActivity, NormalizedEvent } from "@tide/contracts";
import type { AcpToolCall } from "./types.ts";

/**
 * Antigravity native sub-agent (`invoke_subagent` / `start_subagent`) and `/swarm` (`swarm`)
 * tool call translation into Tide `kind: "child"` activities.
 *
 * Keeps `AcpNormalizer` focused on standard ACP updates while giving Antigravity sub-agents
 * and swarm workers the same expandable `ChildGroup` UI that Claude Code and Codex get.
 */

const MAX_REPORT = 8_000;
const MAX_SUMMARY = 200;

function stripNamespace(raw: string): string {
  const idx = raw.lastIndexOf(":");
  return (idx >= 0 ? raw.slice(idx + 1) : raw).trim().toLowerCase();
}

export function isSubagentToolName(name: string | null | undefined): boolean {
  if (!name) return false;
  const clean = stripNamespace(name);
  return clean === "invoke_subagent" || clean === "start_subagent";
}

export function isSwarmToolName(name: string | null | undefined): boolean {
  if (!name) return false;
  return stripNamespace(name) === "swarm";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function strField(obj: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const key of keys) {
    const val = obj[key];
    if (typeof val === "string" && val.trim() !== "") return val.trim();
  }
  return undefined;
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function firstLine(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ? cap(line, MAX_SUMMARY) : undefined;
}

function extractTaskId(rawOutput: unknown, textOutput: string | undefined): string | undefined {
  const obj = asRecord(rawOutput);
  const direct = strField(obj, "conversationId", "conversation_id", "taskId", "task_id", "id");
  if (direct) return direct;
  if (!textOutput) return undefined;
  const match = /\b(?:conversationId|conversation_id|conversation)\s*[:=]\s*["']?([a-zA-Z0-9_-]{8,})["']?/i.exec(textOutput);
  return match?.[1];
}

function childStatus(status: AcpToolCall["status"]): "running" | "done" | "error" {
  if (status === "completed") return "done";
  if (status === "failed") return "error";
  return "running";
}

interface SwarmWorker {
  name: string;
  model?: string;
  workspace?: string;
  status: "running" | "done" | "error";
  summary?: string;
}

function workerDescription(worker: Pick<SwarmWorker, "model" | "workspace">): string {
  const parts = ["swarm"];
  if (worker.model) parts.push(worker.model);
  if (worker.workspace && worker.workspace !== "inherit") parts.push(worker.workspace);
  return parts.join(" · ");
}

function workerActivity(worker: SwarmWorker): DriverActivity {
  return {
    kind: "child",
    childKey: `swarm:${worker.name}`,
    name: worker.name,
    description: workerDescription(worker),
    status: worker.status,
    ...(worker.summary ? { summary: worker.summary } : {}),
  };
}

/**
 * Tracks Antigravity sub-agent and `/swarm` worker rows across a session.
 * Swarm workers persist across turns until killed or the session closes.
 */
export class AcpSubagentTracker {
  #swarmWorkers = new Map<string, SwarmWorker>();
  #titledCalls = new Set<string>();
  #swarmTitle: string | undefined;

  get swarmTitle(): string | undefined {
    return this.#swarmTitle;
  }

  hasActiveSwarmWorkers(): boolean {
    for (const worker of this.#swarmWorkers.values()) {
      if (worker.status === "running") return true;
    }
    return false;
  }

  /**
   * Translates an Antigravity sub-agent or `swarm` tool call into normalized events.
   * Returns `undefined` when the call should be rendered as a normal tool row.
   */
  handleToolCall(call: AcpToolCall, output: string | undefined, fallbackToolActivity: () => DriverActivity): NormalizedEvent[] | undefined {
    const rawName = call.name ?? call.title;
    if (isSubagentToolName(rawName)) {
      return [this.#subagentEvent(call, output)];
    }
    if (isSwarmToolName(rawName)) {
      return this.#swarmEvents(call, output, fallbackToolActivity);
    }
    return undefined;
  }

  /** Marks any still-running swarm workers closed (used when a session ends or is disposed). */
  closeRunningWorkers(summary: string): NormalizedEvent[] {
    const out: NormalizedEvent[] = [];
    for (const worker of this.#swarmWorkers.values()) {
      if (worker.status !== "running") continue;
      worker.status = "done";
      worker.summary = summary;
      out.push({ type: "activity", activity: workerActivity(worker) });
    }
    return out;
  }

  #subagentEvent(call: AcpToolCall, output: string | undefined): NormalizedEvent {
    const input = asRecord(call.rawInput);
    const role = strField(input, "Role", "role", "description");
    const typeName = strField(input, "TypeName", "typeName", "subagent_type", "agent");
    const model = strField(input, "Model", "model");
    const workspace = strField(input, "Workspace", "workspace");
    const prompt = strField(input, "Prompt", "prompt");
    const name = role ?? typeName ?? call.title ?? "sub-agent";
    const badgeParts = [typeName && typeName !== name ? typeName : undefined, model && model !== "inherit" ? model : undefined, workspace && workspace !== "inherit" ? workspace : undefined].filter(
      (part): part is string => part !== undefined,
    );
    const description = badgeParts.length > 0 ? badgeParts.join(" · ") : undefined;
    const status = childStatus(call.status);
    const taskId = extractTaskId(call.rawOutput, output);
    const summary = status === "running" ? firstLine(prompt) : (firstLine(output) ?? firstLine(prompt));
    const report = status !== "running" && output ? cap(output, MAX_REPORT) : undefined;
    return {
      type: "activity",
      activity: {
        kind: "child",
        childKey: call.toolCallId,
        name,
        status,
        ...(taskId ? { taskId } : {}),
        ...(description ? { description } : {}),
        ...(summary ? { summary } : {}),
        ...(report ? { report } : {}),
      },
    };
  }

  #swarmEvents(call: AcpToolCall, output: string | undefined, fallbackToolActivity: () => DriverActivity): NormalizedEvent[] | undefined {
    const input = asRecord(call.rawInput);
    const action = strField(input, "action")?.toLowerCase();
    if (!action || action === "models") return undefined;

    if (action === "title") {
      const title = strField(input, "title");
      if (!title) return undefined;
      this.#swarmTitle = title;
      if (this.#titledCalls.has(call.toolCallId)) return [];
      this.#titledCalls.add(call.toolCallId);
      return [{ type: "activity", activity: { kind: "info", text: `Swarm: ${title}` } }];
    }

    if (action === "add") {
      const baseName = strField(input, "name") ?? "worker";
      const brief = strField(input, "brief");
      const model = strField(input, "model");
      const workspace = strField(input, "workspace");
      const tasks = Array.isArray(input?.["tasks"]) ? input["tasks"].filter((t): t is string => typeof t === "string") : undefined;
      const count = typeof input?.["n"] === "number" && Number.isInteger(input["n"]) && input["n"] > 1 ? input["n"] : undefined;
      const targets: Array<{ name: string; summary: string | undefined }> =
        tasks && tasks.length > 0
          ? tasks.map((task, index) => ({ name: `${baseName}-${index + 1}`, summary: firstLine(task) ?? firstLine(brief) }))
          : count !== undefined
            ? Array.from({ length: count }, (_, index) => ({ name: `${baseName}-${index + 1}`, summary: firstLine(brief) }))
            : [{ name: baseName, summary: firstLine(brief) }];
      const failed = call.status === "failed";
      const events: NormalizedEvent[] = [];
      for (const target of targets) {
        const existing = this.#swarmWorkers.get(target.name);
        const resolvedModel = model ?? existing?.model;
        const resolvedWorkspace = workspace ?? existing?.workspace;
        const resolvedSummary = failed ? (firstLine(output) ?? "failed to start") : (target.summary ?? existing?.summary);
        const worker: SwarmWorker = {
          name: target.name,
          ...(resolvedModel !== undefined ? { model: resolvedModel } : {}),
          ...(resolvedWorkspace !== undefined ? { workspace: resolvedWorkspace } : {}),
          status: failed ? "error" : "running",
          ...(resolvedSummary !== undefined ? { summary: resolvedSummary } : {}),
        };
        this.#swarmWorkers.set(target.name, worker);
        events.push({ type: "activity", activity: workerActivity(worker) });
      }
      return events;
    }

    if (action === "model") {
      const name = strField(input, "name");
      const model = strField(input, "model");
      if (!name || !model) return undefined;
      const worker = this.#swarmWorkers.get(name) ?? { name, status: "running" as const };
      worker.model = model;
      if (call.status === "failed") worker.summary = firstLine(output) ?? "model switch failed";
      this.#swarmWorkers.set(name, worker);
      return [{ type: "activity", activity: workerActivity(worker) }];
    }

    if (action === "kill") {
      const name = strField(input, "name");
      if (!name) return undefined;
      const worker = this.#swarmWorkers.get(name) ?? { name, status: "done" as const };
      worker.status = call.status === "failed" ? "error" : "done";
      worker.summary = firstLine(output) ?? "stopped";
      this.#swarmWorkers.set(name, worker);
      return [{ type: "activity", activity: workerActivity(worker) }];
    }

    if (action === "status") {
      const events: NormalizedEvent[] = [{ type: "activity", activity: fallbackToolActivity() }];
      if (call.status === "completed" && output) {
        for (const worker of this.#parseStatusOutput(output)) {
          events.push({ type: "activity", activity: workerActivity(worker) });
        }
      }
      return events;
    }

    return undefined;
  }

  #parseStatusOutput(output: string): SwarmWorker[] {
    const updated: SwarmWorker[] = [];
    for (const line of output.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      for (const worker of this.#swarmWorkers.values()) {
        if (!new RegExp(`\\b${escapeRegExp(worker.name)}\\b`).test(trimmed)) continue;
        const lower = trimmed.toLowerCase();
        const prevStatus = worker.status;
        const prevSummary = worker.summary;
        if (/\bkilled\b|\bstopped\b/.test(lower)) {
          worker.status = "done";
          worker.summary = lower.includes("killed") ? "stopped" : "paused";
        } else if (/\bwaiting\b/.test(lower)) {
          worker.status = "running";
          worker.summary = "waiting on board";
        } else if (/\bworking\b/.test(lower)) {
          worker.status = "running";
          if (worker.summary === "waiting on board") worker.summary = "working";
        }
        if (worker.status !== prevStatus || worker.summary !== prevSummary) updated.push(worker);
      }
    }
    return updated;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
