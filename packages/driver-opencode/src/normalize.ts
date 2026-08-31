import type { DriverActivity, NormalizedEvent, TurnUsage } from "@tide/contracts";
import type {
  OpencodeEvent,
  WireAssistantMessage,
  WireMessage,
  WireMessageError,
  WirePart,
  WirePermission,
  WireQuestionRequest,
  WireTextPart,
  WireTodo,
  WireToolPart,
  WireTokens,
} from "./wire.ts";

const MAX_OUTPUT_CHARS = 4096;
const SUBAGENT_TOOLS = new Set(["task", "subtask", "agent"]);

export interface NormalizerOptions {
  /** only events carrying this session id are translated */
  sessionId: string;
  /** the agent this session runs (`plan` turns produce a ProposedPlan) */
  agent: string;
  /** model context window from the provider catalog, when known */
  contextWindow?: number;
  onUnknown?: (type: string) => void;
}

interface TrackedTool {
  toolName: string;
  input: unknown;
  status: string;
  child: boolean;
  childName?: string;
}

export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

function errorText(error: WireMessageError | undefined): string | undefined {
  if (!error) return undefined;
  const message = error.data?.message;
  return truncate(message !== undefined && message !== "" ? `${error.name}: ${message}` : error.name, 1000);
}

function todoStatus(status: string): "pending" | "in_progress" | "completed" {
  return status === "in_progress" || status === "completed" ? status : "pending";
}

function permissionKind(permission: WirePermission): string {
  return permission.permission ?? permission.type ?? "permission";
}

function permissionPatterns(permission: WirePermission): string[] {
  if (permission.patterns) return permission.patterns;
  if (Array.isArray(permission.pattern)) return permission.pattern;
  return permission.pattern !== undefined ? [permission.pattern] : [];
}

function permissionDiff(permission: WirePermission): string | undefined {
  const diff = permission.metadata?.["diff"];
  return typeof diff === "string" && diff !== "" ? truncate(diff, 20_000) : undefined;
}

function addTokens(into: WireTokens | undefined, from: WireTokens | undefined): WireTokens | undefined {
  if (!from) return into;
  if (!into) return from;
  return {
    input: into.input + from.input,
    output: into.output + from.output,
    cache: { read: (into.cache?.read ?? 0) + (from.cache?.read ?? 0), write: (into.cache?.write ?? 0) + (from.cache?.write ?? 0) },
  };
}

/**
 * Stateful but I/O-free translator from opencode's SSE event stream to `NormalizedEvent`s.
 * State is only what the stream cannot repeat: per-part text (to derive deltas when the
 * server omits `delta`), open tool calls, and the running token/cost total of the turn.
 */
export class OpencodeNormalizer {
  #opts: NormalizerOptions;
  #tools = new Map<string, TrackedTool>();
  #toolByCall = new Map<string, TrackedTool>();
  /** messageID -> partID -> full text so far (assistant text, for plan markdown) */
  #messageParts = new Map<string, Map<string, string>>();
  #completed = new Set<string>();
  /** messageID -> role, so a user message's own text parts never stream back as assistant text */
  #roles = new Map<string, string>();
  #tokens: WireTokens | undefined;
  #cost = 0;
  #error: string | undefined;
  #interrupted = false;
  #retryAttempt = 0;
  #settled = false;
  unknownCount = 0;

  constructor(options: NormalizerOptions) {
    this.#opts = options;
  }

  /** Marks the turn as user-interrupted so `session.idle` settles as `interrupted`. */
  markInterrupted(): void {
    this.#interrupted = true;
  }

  next(event: OpencodeEvent): NormalizedEvent[] {
    switch (event.type) {
      case "message.updated":
        return this.#messageUpdated((event.properties as { info: WireMessage }).info);
      case "message.part.updated": {
        const properties = event.properties as { part: WirePart; delta?: string };
        return this.#partUpdated(properties.part, properties.delta);
      }
      case "permission.asked":
      case "permission.updated":
        return this.#permission(event.properties as WirePermission);
      case "question.asked":
        return this.#question(event.properties as WireQuestionRequest);
      case "todo.updated":
        return this.#todos(event.properties as { sessionID: string; todos: WireTodo[] });
      case "session.compacted":
        return this.#owned(event.properties) ? [{ type: "activity", activity: { kind: "info", text: "Context compacted" } }] : [];
      case "session.status":
        return this.#sessionStatus(event.properties as { sessionID?: string; status?: { type?: string; attempt?: number; message?: string } });
      case "session.error":
        return this.#sessionError(event.properties as { sessionID?: string; error?: WireMessageError });
      case "session.idle":
        return this.#owned(event.properties) ? this.#settle() : [];
      case "permission.replied":
      case "question.replied":
      case "question.rejected":
      case "session.updated":
      case "session.diff":
      case "message.removed":
      case "message.part.removed":
      case "file.edited":
      case "file.watcher.updated":
      case "server.connected":
      case "server.heartbeat":
        return [];
      default:
        this.unknownCount++;
        this.#opts.onUnknown?.(event.type);
        return [];
    }
  }

  #owned(properties: unknown): boolean {
    if (typeof properties !== "object" || properties === null) return false;
    const sessionID = (properties as { sessionID?: unknown }).sessionID;
    return sessionID === undefined || sessionID === this.#opts.sessionId;
  }

  #messageUpdated(info: WireMessage): NormalizedEvent[] {
    if (info.sessionID !== this.#opts.sessionId) return [];
    this.#roles.set(info.id, info.role);
    if (info.role !== "assistant") return [];
    const message = info as WireAssistantMessage;
    if (message.time.completed === undefined) return [];
    if (this.#completed.has(message.id)) return [];
    this.#completed.add(message.id);
    this.#tokens = addTokens(this.#tokens, message.tokens);
    this.#cost += message.cost ?? 0;
    const error = errorText(message.error);
    if (error !== undefined) {
      if (message.error?.name === "MessageAbortedError") this.#interrupted = true;
      else this.#error ??= error;
    }
    const agent = message.agent ?? message.mode ?? this.#opts.agent;
    const markdown = this.#textOf(message.id);
    // The plan agent's answer *is* the plan; Tide records it and never implements it here.
    if (agent === "plan" && markdown.trim() !== "") return [{ type: "plan.proposed", markdown }];
    return [];
  }

  #partUpdated(part: WirePart, delta: string | undefined): NormalizedEvent[] {
    if (part.sessionID !== this.#opts.sessionId) return [];
    if (part.type === "text") return this.#textPart(part as WireTextPart, delta);
    if (part.type === "tool") return this.#toolPart(part as WireToolPart);
    if (part.type === "subtask") {
      const subtask = part as { id: string; agent: string; description: string };
      return [
        {
          type: "activity",
          activity: { kind: "child", childKey: subtask.id, name: subtask.agent, description: subtask.description, status: "running" },
        },
      ];
    }
    return [];
  }

  #textPart(part: WireTextPart, delta: string | undefined): NormalizedEvent[] {
    if (part.synthetic === true || this.#roles.get(part.messageID) === "user") return [];
    const parts = this.#messageParts.get(part.messageID) ?? new Map<string, string>();
    const previous = parts.get(part.id) ?? "";
    // `delta` is authoritative when present; otherwise the part carries the full text so far.
    const increment = delta ?? (part.text.startsWith(previous) ? part.text.slice(previous.length) : part.text);
    parts.set(part.id, part.text);
    this.#messageParts.set(part.messageID, parts);
    if (increment === "") return [];
    return [{ type: "assistant.delta", messageKey: part.id, delta: increment }];
  }

  #textOf(messageId: string): string {
    return [...(this.#messageParts.get(messageId)?.values() ?? [])].join("");
  }

  #toolPart(part: WireToolPart): NormalizedEvent[] {
    const state = part.state;
    if (state.status === "pending") return [];
    const input = state.input ?? {};
    const tracked = this.#tools.get(part.id);
    const child = tracked?.child ?? SUBAGENT_TOOLS.has(part.tool);
    const childName = tracked?.childName ?? childLabel(part.tool, input);
    if (tracked?.status === state.status) return [];
    const entry: TrackedTool = { toolName: part.tool, input, status: state.status, child, ...(childName ? { childName } : {}) };
    this.#tools.set(part.id, entry);
    this.#toolByCall.set(part.callID, entry);

    const output = state.status === "completed" ? state.output : state.status === "error" ? state.error : undefined;
    const status = state.status === "completed" ? "ok" : state.status === "error" ? "error" : "running";
    const activity: DriverActivity = {
      kind: "tool",
      toolUseId: part.id,
      toolName: part.tool,
      input,
      status,
      ...(output !== undefined && output !== "" ? { output: truncate(output) } : {}),
      ...(state.time?.start !== undefined && state.time.end !== undefined ? { durationMs: state.time.end - state.time.start } : {}),
    };
    const events: NormalizedEvent[] = [{ type: "activity", activity }];
    if (child) {
      events.push({
        type: "activity",
        activity: {
          kind: "child",
          childKey: part.id,
          name: childName ?? part.tool,
          status: status === "ok" ? "done" : status === "error" ? "error" : "running",
          ...(output !== undefined && output !== "" ? { summary: truncate(output, 1000) } : {}),
        },
      });
    }
    return events;
  }

  #permission(permission: WirePermission): NormalizedEvent[] {
    if (permission.sessionID !== this.#opts.sessionId) return [];
    const kind = permissionKind(permission);
    // `plan_exit` is opencode asking to leave planning and start editing: capture the plan
    // and never allow it here (the session rejects it; the user promotes it to a thread).
    if (kind === "plan_exit") {
      const plan = permission.metadata?.["plan"] ?? permission.metadata?.["text"];
      const markdown = typeof plan === "string" ? plan : (this.#lastAssistantText() ?? "");
      return markdown.trim() === "" ? [] : [{ type: "plan.proposed", markdown }];
    }
    const callId = permission.tool?.callID ?? permission.callID;
    // The permission itself only carries patterns; the pending tool call has the real input.
    const tracked = callId === undefined ? undefined : this.#toolByCall.get(callId);
    const patterns = permissionPatterns(permission);
    const diff = permissionDiff(permission);
    return [
      {
        type: "activity",
        activity: {
          kind: "approval",
          requestId: permission.id,
          toolName: tracked?.toolName ?? kind,
          input: tracked?.input ?? { ...(patterns.length > 0 ? { patterns } : {}), ...(permission.metadata ? { metadata: permission.metadata } : {}) },
          status: "pending",
          ...(permission.title ? { title: permission.title } : {}),
          ...(patterns.length > 0 ? { description: truncate(patterns.join(", "), 300) } : {}),
          ...(diff ? { diff } : {}),
        },
      },
    ];
  }

  #lastAssistantText(): string | undefined {
    let latest: string | undefined;
    for (const messageId of this.#messageParts.keys()) latest = this.#textOf(messageId);
    return latest;
  }

  #question(request: WireQuestionRequest): NormalizedEvent[] {
    if (request.sessionID !== this.#opts.sessionId) return [];
    return [
      {
        type: "activity",
        activity: {
          kind: "user-input",
          requestId: request.id,
          status: "pending",
          questions: request.questions.map((question, index) => ({
            id: `q${index}`,
            text: question.question,
            options: (question.options ?? []).map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
            ...(question.multiple === true ? { multi: true } : {}),
          })),
        },
      },
    ];
  }

  #todos(properties: { sessionID: string; todos: WireTodo[] }): NormalizedEvent[] {
    if (properties.sessionID !== this.#opts.sessionId) return [];
    const steps = properties.todos.map((todo) => ({ text: todo.content, status: todoStatus(todo.status) }));
    return steps.length > 0 ? [{ type: "plan.progress", steps }] : [];
  }

  /** Only the non-nominal states are worth a row; `busy`/`idle` are already implied. */
  #sessionStatus(properties: { sessionID?: string; status?: { type?: string; attempt?: number; message?: string } }): NormalizedEvent[] {
    if (!this.#owned(properties) || properties.status?.type !== "retry") return [];
    const attempt = properties.status.attempt ?? 1;
    if (attempt === this.#retryAttempt) return [];
    this.#retryAttempt = attempt;
    const reason = properties.status.message;
    return [{ type: "activity", activity: { kind: "info", text: `Retrying (attempt ${attempt})${reason ? `: ${truncate(reason, 300)}` : ""}` } }];
  }

  #sessionError(properties: { sessionID?: string; error?: WireMessageError }): NormalizedEvent[] {
    if (!this.#owned(properties)) return [];
    if (properties.error?.name === "MessageAbortedError") {
      this.#interrupted = true;
      return this.#settle();
    }
    this.#error ??= errorText(properties.error) ?? "opencode reported a session error";
    return this.#settle();
  }

  /** Usage first, then exactly one `settled` per turn. */
  #settle(): NormalizedEvent[] {
    if (this.#settled) return [];
    this.#settled = true;
    const events: NormalizedEvent[] = [];
    const usage = this.#usage();
    if (usage) {
      const window = this.#opts.contextWindow;
      const used = (this.#tokens?.input ?? 0) + (this.#tokens?.cache?.read ?? 0) + (this.#tokens?.cache?.write ?? 0) + (this.#tokens?.output ?? 0);
      events.push({ type: "usage", usage, ...(window !== undefined && window > 0 ? { contextUsage: { used, window } } : {}) });
    }
    if (this.#interrupted) events.push({ type: "settled", status: "interrupted" });
    else if (this.#error !== undefined) events.push({ type: "settled", status: "error", error: this.#error });
    else events.push({ type: "settled", status: "completed" });
    return events;
  }

  #usage(): TurnUsage | undefined {
    const tokens = this.#tokens;
    if (!tokens) return undefined;
    return {
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      ...(tokens.cache?.read !== undefined ? { cacheReadTokens: tokens.cache.read } : {}),
      ...(tokens.cache?.write !== undefined ? { cacheWriteTokens: tokens.cache.write } : {}),
      ...(this.#cost > 0 ? { costUsd: this.#cost } : {}),
    };
  }
}

function childLabel(tool: string, input: Record<string, unknown>): string | undefined {
  if (!SUBAGENT_TOOLS.has(tool)) return undefined;
  for (const key of ["description", "subagent_type", "agent", "prompt"]) {
    const value = input[key];
    if (typeof value === "string" && value !== "") return truncate(value, 120);
  }
  return tool;
}
