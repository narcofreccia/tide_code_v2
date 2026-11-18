import type { DriverActivity, NormalizedEvent, TurnUsage } from "@tide/contracts";
import type { EventOf, OpencodeEvent, WireForm, WireTokens } from "./wire.ts";

const MAX_OUTPUT_CHARS = 4096;
const MAX_PAYLOAD_CHARS = 4096;
/** v2 renamed v1 `task` to `subagent` (core's v1 config migration maps `task → subagent`). */
const SUBAGENT_TOOLS = new Set(["subagent", "task"]);

/**
 * Session-scoped events dropped without a trace: housekeeping, Tide's own requests echoed
 * back, or pieces this normalizer folds into another row. Everything else that names this
 * session — including event types never seen before — becomes a generic `info` row carrying
 * the raw event (CLAUDE.md §1a), so a new OpenCode release never goes silent.
 */
export const SILENT_EVENTS = new Set([
  "session.inbox.enqueued", // Tide's own prompt, admitted
  "session.inbox.delivered",
  "session.execution.started",
  "session.instructions.updated", // instruction hashes per step
  "session.step.started",
  "session.step.streamed",
  "session.text.started",
  "session.reasoning.started",
  "session.reasoning.ended", // deltas already streamed
  "session.tool.input.started", // folded into the tool row
  "session.tool.input.delta",
  "session.tool.input.ended",
  "session.tool.progress", // shell ids etc.; the tool row's result carries the output
  "session.usage.updated", // folded into `usage`
  "session.status", // busy/idle/retry; retry has its own row via `session.retry.scheduled`
  "session.idle",
  "session.renamed", // auto title
  "session.viewed",
  "session.agent.selected", // Tide's own reconfigure
  "session.model.selected",
  "session.permissions",
  "session.metadata.updated",
  "permission.replied", // the approval card already shows the decision
  "form.replied", // ditto for the user-input card
  "form.cancelled",
  "session.compaction.started",
  "session.compaction.delta",
]);

/** Unscoped events surfaced when they concern the thread's own directory (worktree tools). */
const LOCATION_EVENTS = new Set(["worktree.updated", "worktree.resolved"]);

/**
 * Events of a sub-agent's child session that never become rows: its text and reasoning (the
 * child row's summary/report carries the outcome, as for Claude and Codex) and its own
 * execution lifecycle, which must not settle the Tide turn.
 */
const CHILD_SILENT_EVENTS = new Set([
  "session.text.delta",
  "session.text.ended",
  "session.reasoning.delta",
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
]);

/** The sub-agent tool's success text wraps the report: `<subagent sessionID=… state="completed">\n…\n</subagent>`. */
const SUBAGENT_ENVELOPE = /^\s*<subagent\b[^>]*>\n?([\s\S]*?)\n?<\/subagent>\s*$/;
const MAX_REPORT_CHARS = 8192;

export interface NormalizerOptions {
  sessionId: string;
  /** the session's working directory (for location-scoped pass-through) */
  directory?: string;
  /** model context window from the catalog, when known */
  contextWindow?: number;
  /** cumulative session usage before this turn (`Session.Info` cost/tokens) */
  baseline?: { cost: number; tokens: WireTokens };
  onUnknown?: (type: string) => void;
  /**
   * A sub-agent session of this turn became known: `created` when its `session.created` was
   * seen in this turn, false when an existing child was resumed (`subagent {sessionID}`).
   */
  onChildSession?: (childId: string, parentId: string, created: boolean) => void;
}

interface TrackedTool {
  name: string;
  input: unknown;
  startedAt?: number;
  child: boolean;
  /** the child row this tool runs under, for tools of a sub-agent session */
  parent?: string;
}

/** A sub-agent session followed in this turn. */
interface ChildSession {
  /** `childKey` of its row: the id of the `subagent` tool call that runs it, once known */
  childKey?: string;
  created: boolean;
}

export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]`;
}

/** The raw event on a pass-through row; anything over ~4 KB of JSON becomes truncated JSON text. */
export function passthroughPayload(event: OpencodeEvent): unknown {
  let json: string;
  try {
    json = JSON.stringify(event) ?? "";
  } catch {
    return { type: event.type };
  }
  if (json.length <= MAX_PAYLOAD_CHARS) return event;
  return `${json.slice(0, MAX_PAYLOAD_CHARS)}… [truncated ${json.length - MAX_PAYLOAD_CHARS} chars]`;
}

function contentText(content: { type: string; text?: string }[] | undefined): string {
  return (content ?? []).flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("\n");
}

function childLabel(input: unknown): string | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  for (const key of ["description", "agent", "subagent_type", "prompt"]) {
    const value = (input as Record<string, unknown>)[key];
    if (typeof value === "string" && value !== "") return truncate(value, 120);
  }
  return undefined;
}

export function sumTokens(a: WireTokens, b: WireTokens, sign = 1): WireTokens {
  return {
    input: a.input + sign * b.input,
    output: a.output + sign * b.output,
    reasoning: a.reasoning + sign * b.reasoning,
    cache: { read: a.cache.read + sign * b.cache.read, write: a.cache.write + sign * b.cache.write },
  };
}

export const ZERO_TOKENS: WireTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

/** Where an event came from: the turn's session or a sub-agent's, and the child row it nests under. */
interface Scope {
  session: string;
  parent?: string;
}

function toolKey(session: string, id: string): string {
  return `${session}\u0000${id}`;
}

/** The sub-agent's final answer out of the tool's `<subagent …>` envelope, capped at 8 KB. */
export function subagentReport(text: string): string | undefined {
  const inner = SUBAGENT_ENVELOPE.exec(text)?.[1]?.trim();
  if (inner === undefined || inner === "") return undefined;
  return inner.length <= MAX_REPORT_CHARS ? inner : `${inner.slice(0, MAX_REPORT_CHARS - 1)}…`;
}

/** The question tool's form (`metadata.kind: "question"`) as Tide user-input questions. */
export function formQuestions(form: WireForm): { id: string; text: string; options?: { label: string; description?: string }[]; multi?: boolean }[] {
  return form.fields
    .filter((field) => field.type !== "external")
    .map((field) => ({
      id: field.key,
      text: field.description ?? field.title ?? field.key,
      ...(field.options && field.options.length > 0
        ? { options: field.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })) }
        : {}),
      ...(field.type === "multiselect" ? { multi: true } : {}),
    }));
}

/**
 * Stateful, I/O-free translator from OpenCode 2's session event stream to `NormalizedEvent`s
 * for one turn. A turn ends on `session.execution.{succeeded,failed,interrupted}`.
 *
 * Usage: `session.usage.updated` carries the session's *cumulative* totals (title generation
 * included, which `session.step.ended` does not report), so the turn's delta is the last total
 * minus the baseline the session had when the turn started. Reasoning tokens are reported
 * separately by OpenCode and counted into `outputTokens` (they are billed as output).
 */
export class OpencodeNormalizer {
  #opts: NormalizerOptions;
  /** keyed by `toolKey(session, call id)`: call ids are only unique within a session */
  #tools = new Map<string, TrackedTool>();
  #children = new Map<string, ChildSession>();
  /** what the sub-agent sessions spent; OpenCode keeps it on the child, not the parent */
  #childUsage = { cost: 0, tokens: ZERO_TOKENS };
  /** assistantMessageID -> final text of that message (for the plan markdown) */
  #texts = new Map<string, string>();
  #streamedText = new Set<string>();
  #agent: string | undefined;
  #latest: { cost: number; tokens: WireTokens } | undefined;
  #lastStep: WireTokens | undefined;
  #error: string | undefined;
  #interrupted = false;
  #settled = false;
  unknownCount = 0;

  constructor(options: NormalizerOptions) {
    this.#opts = options;
  }

  /** Marks the turn as user-interrupted so a failure caused by the abort settles as `interrupted`. */
  markInterrupted(): void {
    this.#interrupted = true;
  }

  /** The cumulative usage last seen (the next turn's baseline). */
  get latestUsage(): { cost: number; tokens: WireTokens } | undefined {
    return this.#latest;
  }

  /** Whether events of `sessionId` belong to this turn (the session itself or a followed sub-agent). */
  owns(sessionId: string): boolean {
    return sessionId === this.#opts.sessionId || this.#children.has(sessionId);
  }

  /** The sub-agent sessions this turn learned. */
  get childSessions(): string[] {
    return [...this.#children.keys()];
  }

  next(event: OpencodeEvent): NormalizedEvent[] {
    if (this.#settled) return [];
    const data = (event as { data?: Record<string, unknown> }).data;
    const sessionId = (data?.["sessionID"] as string | undefined) ?? (data?.["form"] as { sessionID?: string } | undefined)?.sessionID;
    if (sessionId === undefined) return this.#unscoped(event);
    const e = event as OpencodeEvent;
    if (e.type === "session.created") {
      const parent = data?.["parentID"];
      if (typeof parent === "string" && this.owns(parent)) this.#learnChild(sessionId, parent, undefined, true);
      return [];
    }
    if (e.type === "session.tool.progress" && this.owns(sessionId)) return this.#progress(sessionId, e as EventOf<"session.tool.progress">);
    if (sessionId !== this.#opts.sessionId) {
      const child = this.#children.get(sessionId);
      return child ? this.#childEvent(sessionId, child, e) : [];
    }
    const main = { session: sessionId };
    switch (e.type) {
      case "session.text.delta":
        return this.#text(e as EventOf<"session.text.delta">);
      case "session.text.ended":
        return this.#textEnded(e as EventOf<"session.text.ended">);
      case "session.reasoning.delta": {
        const d = (e as EventOf<"session.reasoning.delta">).data;
        return d.delta === "" ? [] : [{ type: "assistant.reasoning", messageKey: d.assistantMessageID, delta: d.delta }];
      }
      case "session.step.started":
        this.#agent = (e as EventOf<"session.step.started">).data.agent;
        return [];
      case "session.tool.input.started":
        return this.#toolStarted(main, e as EventOf<"session.tool.input.started">);
      case "session.tool.called":
        return this.#toolCalled(main, e as EventOf<"session.tool.called">);
      case "session.tool.success":
        return this.#toolDone(main, e as EventOf<"session.tool.success">, "ok");
      case "session.tool.failed":
        return this.#toolDone(main, e as EventOf<"session.tool.failed">, "error");
      case "permission.asked":
        return this.#permission(main, e as EventOf<"permission.asked">);
      case "form.created":
        return this.#form(main, (e as EventOf<"form.created">).data.form as unknown as WireForm);
      case "session.step.ended":
        this.#lastStep = (e as EventOf<"session.step.ended">).data.tokens;
        return [];
      case "session.step.failed": {
        const d = (e as EventOf<"session.step.failed">).data;
        if (d.tokens) this.#lastStep = d.tokens;
        if (d.error.type !== "aborted") this.#error ??= truncate(`${d.error.type}: ${d.error.message}`, 1000);
        return [];
      }
      case "session.usage.updated": {
        const d = (e as EventOf<"session.usage.updated">).data;
        this.#latest = { cost: d.cost, tokens: d.tokens };
        return [];
      }
      case "session.retry.scheduled": {
        const d = (e as EventOf<"session.retry.scheduled">).data;
        return [this.#info(main, `Retrying (attempt ${d.attempt}): ${truncate(d.error.message, 300)}`)];
      }
      case "session.compaction.ended":
        return [{ type: "activity", activity: { kind: "info", text: "Context compacted" } }];
      case "session.execution.succeeded":
        return this.#settle(this.#interrupted ? "interrupted" : "completed");
      case "session.execution.interrupted":
        return this.#settle("interrupted");
      case "session.execution.failed": {
        const error = (e as EventOf<"session.execution.failed">).data.error;
        if (this.#interrupted || error.type === "aborted") return this.#settle("interrupted");
        this.#error = truncate(`${error.type}: ${error.message}`, 1000);
        return this.#settle("error");
      }
      default:
        return this.#passthrough(main, e);
    }
  }

  /**
   * One event of a followed sub-agent session. Its tools, approvals, forms and unknown events
   * become rows under the child row (`parentToolUseId` = the launching tool call's id); its
   * text, reasoning and execution end are dropped (see `CHILD_SILENT_EVENTS`); its steps' usage
   * is added to the turn's.
   */
  #childEvent(sessionId: string, child: ChildSession, e: OpencodeEvent): NormalizedEvent[] {
    const scope = { session: sessionId, ...(child.childKey !== undefined ? { parent: child.childKey } : {}) };
    switch (e.type) {
      case "session.tool.input.started":
        return this.#toolStarted(scope, e as EventOf<"session.tool.input.started">);
      case "session.tool.called":
        return this.#toolCalled(scope, e as EventOf<"session.tool.called">);
      case "session.tool.success":
        return this.#toolDone(scope, e as EventOf<"session.tool.success">, "ok");
      case "session.tool.failed":
        return this.#toolDone(scope, e as EventOf<"session.tool.failed">, "error");
      case "permission.asked":
        return this.#permission(scope, e as EventOf<"permission.asked">);
      case "form.created":
        return this.#form(scope, (e as EventOf<"form.created">).data.form as unknown as WireForm);
      case "session.step.started":
        return [];
      case "session.step.ended": {
        const d = (e as EventOf<"session.step.ended">).data;
        this.#addChildUsage(d.cost, d.tokens);
        return [];
      }
      case "session.step.failed": {
        const d = (e as EventOf<"session.step.failed">).data;
        if (d.tokens && d.cost !== undefined) this.#addChildUsage(d.cost, d.tokens);
        return [];
      }
      // title/compaction usage; core projects it like a step's (not seen on the stream so far)
      case "session.usage.recorded": {
        const d = (e as { data?: { cost?: unknown; tokens?: WireTokens } }).data;
        if (typeof d?.cost === "number" && d.tokens) this.#addChildUsage(d.cost, d.tokens);
        return [];
      }
      case "session.retry.scheduled": {
        const d = (e as EventOf<"session.retry.scheduled">).data;
        return [this.#info(scope, `Sub-agent retrying (attempt ${d.attempt}): ${truncate(d.error.message, 300)}`)];
      }
      default:
        return CHILD_SILENT_EVENTS.has(e.type) ? [] : this.#passthrough(scope, e);
    }
  }

  #addChildUsage(cost: number, tokens: WireTokens): void {
    this.#childUsage = { cost: this.#childUsage.cost + cost, tokens: sumTokens(this.#childUsage.tokens, tokens) };
  }

  /**
   * The `subagent` tool reports `{sessionID, status: "running"}` as progress right after it
   * creates (or picks up) the child session and before prompting it: the link between the
   * child session and the tool call whose row it nests under.
   */
  #progress(sessionId: string, event: EventOf<"session.tool.progress">): NormalizedEvent[] {
    const d = event.data;
    const tracked = this.#tools.get(toolKey(sessionId, d.id));
    const childId = d.metadata?.["sessionID"];
    if (tracked?.child && typeof childId === "string" && childId !== sessionId) this.#learnChild(childId, sessionId, d.id, false);
    return [];
  }

  #learnChild(childId: string, parentId: string, childKey: string | undefined, created: boolean): void {
    const known = this.#children.get(childId);
    if (known) {
      if (childKey !== undefined) known.childKey = childKey;
      return;
    }
    this.#children.set(childId, { ...(childKey !== undefined ? { childKey } : {}), created });
    this.#opts.onChildSession?.(childId, parentId, created);
  }

  #info(scope: Scope, text: string, payload?: unknown): NormalizedEvent {
    return {
      type: "activity",
      activity: { kind: "info", text, ...(payload !== undefined ? { payload } : {}), ...(scope.parent !== undefined ? { parentToolUseId: scope.parent } : {}) },
    };
  }

  /** Ends the turn from outside the stream (the stream died); idempotent. */
  abort(reason: string): NormalizedEvent[] {
    this.#error = reason;
    return this.#settle("error");
  }

  #passthrough(scope: Scope, event: OpencodeEvent): NormalizedEvent[] {
    if (SILENT_EVENTS.has(event.type)) return [];
    // revert/snapshot (`session.revert.*`), compaction failures, subagent forks, skills, …:
    // shown as they come. Tide keeps its own checkpoints and does not translate these.
    if (!event.type.startsWith("session.revert.")) {
      this.unknownCount++;
      this.#opts.onUnknown?.(event.type);
    }
    return [this.#info(scope, `opencode: ${event.type}`, passthroughPayload(event))];
  }

  #unscoped(event: OpencodeEvent): NormalizedEvent[] {
    if (!LOCATION_EVENTS.has(event.type)) return [];
    const directory = (event as { location?: { directory?: string } }).location?.directory ?? (event as { data?: { directory?: string } }).data?.directory;
    if (this.#opts.directory === undefined || directory !== this.#opts.directory) return [];
    return [{ type: "activity", activity: { kind: "info", text: `opencode: ${event.type}`, payload: passthroughPayload(event) } }];
  }

  #text(event: EventOf<"session.text.delta">): NormalizedEvent[] {
    const d = event.data;
    if (d.delta === "") return [];
    this.#streamedText.add(`${d.assistantMessageID}:${d.ordinal}`);
    return [{ type: "assistant.delta", messageKey: d.assistantMessageID, delta: d.delta }];
  }

  /** Keeps the message text for the plan; emits it whole if no delta was streamed for it. */
  #textEnded(event: EventOf<"session.text.ended">): NormalizedEvent[] {
    const d = event.data;
    const previous = this.#texts.get(d.assistantMessageID);
    this.#texts.set(d.assistantMessageID, previous === undefined ? d.text : `${previous}${d.text}`);
    if (this.#streamedText.has(`${d.assistantMessageID}:${d.ordinal}`) || d.text === "") return [];
    return [{ type: "assistant.delta", messageKey: d.assistantMessageID, delta: d.text }];
  }

  #toolStarted(scope: Scope, event: EventOf<"session.tool.input.started">): NormalizedEvent[] {
    const d = event.data;
    this.#tools.set(toolKey(scope.session, d.id), { name: d.name, input: {}, child: SUBAGENT_TOOLS.has(d.name), ...(scope.parent !== undefined ? { parent: scope.parent } : {}) });
    return [];
  }

  #tracked(scope: Scope, id: string): TrackedTool {
    return this.#tools.get(toolKey(scope.session, id)) ?? { name: "tool", input: {}, child: false, ...(scope.parent !== undefined ? { parent: scope.parent } : {}) };
  }

  #toolCalled(scope: Scope, event: EventOf<"session.tool.called">): NormalizedEvent[] {
    const d = event.data;
    const tracked = this.#tracked(scope, d.id);
    tracked.input = d.input;
    tracked.startedAt = event.created;
    this.#tools.set(toolKey(scope.session, d.id), tracked);
    const nest = tracked.parent !== undefined ? { parentToolUseId: tracked.parent } : {};
    const events: NormalizedEvent[] = [{ type: "activity", activity: { kind: "tool", toolUseId: d.id, toolName: tracked.name, input: d.input, status: "running", ...nest } }];
    if (tracked.child) {
      const description = childLabel(d.input);
      events.push({
        type: "activity",
        activity: { kind: "child", childKey: d.id, name: description ?? tracked.name, ...(description ? { description } : {}), status: "running", ...nest },
      });
    }
    return events;
  }

  #toolDone(scope: Scope, event: EventOf<"session.tool.success"> | EventOf<"session.tool.failed">, status: "ok" | "error"): NormalizedEvent[] {
    const d = event.data;
    const tracked = this.#tracked(scope, d.id);
    const nest = tracked.parent !== undefined ? { parentToolUseId: tracked.parent } : {};
    const text = contentText(d.content as { type: string; text?: string }[] | undefined);
    const failure = "error" in d ? `${d.error.type}: ${d.error.message}` : undefined;
    const output = text !== "" ? text : failure;
    const activity: DriverActivity = {
      kind: "tool",
      toolUseId: d.id,
      toolName: tracked.name,
      input: tracked.input,
      status,
      ...(output !== undefined && output !== "" ? { output: truncate(output) } : {}),
      ...(tracked.startedAt !== undefined ? { durationMs: Math.max(0, event.created - tracked.startedAt) } : {}),
      ...nest,
    };
    const events: NormalizedEvent[] = [{ type: "activity", activity }];
    if (tracked.child) {
      const report = status === "ok" ? subagentReport(text) : undefined;
      events.push({
        type: "activity",
        activity: {
          kind: "child",
          childKey: d.id,
          name: childLabel(tracked.input) ?? tracked.name,
          status: status === "ok" ? "done" : "error",
          ...(output ? { summary: truncate(report ?? output, 1000) } : {}),
          ...(report ? { report } : {}),
          ...nest,
        },
      });
    }
    return events;
  }

  #permission(scope: Scope, event: EventOf<"permission.asked">): NormalizedEvent[] {
    const d = event.data;
    const tracked = d.source ? this.#tools.get(toolKey(scope.session, d.source.id)) : undefined;
    const files = (d.metadata?.["files"] as { patch?: unknown }[] | undefined) ?? [];
    const diff = files.flatMap((file) => (typeof file.patch === "string" ? [file.patch] : [])).join("\n");
    return [
      {
        type: "activity",
        activity: {
          kind: "approval",
          requestId: d.id,
          toolName: tracked?.name ?? d.action,
          input: tracked?.input ?? { action: d.action, resources: d.resources },
          status: "pending",
          title: d.message ?? `${d.action}: ${truncate(d.resources.join(", "), 200)}`,
          ...(d.resources.length > 0 ? { description: truncate(d.resources.join(", "), 300) } : {}),
          ...(diff !== "" ? { diff: truncate(diff, 20_000) } : {}),
          ...(scope.parent !== undefined ? { parentToolUseId: scope.parent } : {}),
        },
      },
    ];
  }

  #form(scope: Scope, form: WireForm): NormalizedEvent[] {
    const questions = formQuestions(form);
    if (questions.length === 0) return this.#passthrough(scope, { type: "form.created", data: { form } });
    return [
      { type: "activity", activity: { kind: "user-input", requestId: form.id, status: "pending", questions, ...(scope.parent !== undefined ? { parentToolUseId: scope.parent } : {}) } },
    ];
  }

  /** Usage first, then a plan (plan agent), then exactly one `settled`. */
  #settle(status: "completed" | "interrupted" | "error"): NormalizedEvent[] {
    if (this.#settled) return [];
    this.#settled = true;
    const events: NormalizedEvent[] = [];
    const usage = this.#usage();
    const window = this.#opts.contextWindow;
    const step = this.#lastStep;
    const contextUsage = window !== undefined && window > 0 && step ? { used: step.input + step.cache.read + step.cache.write + step.output, window } : undefined;
    if (usage || contextUsage) events.push({ type: "usage", ...(usage ? { usage } : {}), ...(contextUsage ? { contextUsage } : {}) });
    // The plan agent's final answer *is* the plan; Tide records it and never implements it here.
    if (status === "completed" && this.#agent === "plan") {
      const markdown = [...this.#texts.values()].filter((text) => text.trim() !== "").at(-1);
      if (markdown !== undefined) events.push({ type: "plan.proposed", markdown });
    }
    if (status === "error") events.push({ type: "settled", status, error: this.#error ?? "opencode reported a failed execution" });
    else events.push({ type: "settled", status });
    return events;
  }

  /** The parent session's delta (cumulative total − baseline) plus what its sub-agents spent. */
  #usage(): TurnUsage | undefined {
    const latest = this.#latest;
    const children = this.#childUsage;
    if (!latest && this.#children.size === 0) return undefined;
    const base = this.#opts.baseline ?? { cost: 0, tokens: ZERO_TOKENS };
    const own = latest ? { cost: latest.cost - base.cost, tokens: sumTokens(latest.tokens, base.tokens, -1) } : { cost: 0, tokens: ZERO_TOKENS };
    const t = sumTokens(own.tokens, children.tokens);
    const cost = own.cost + children.cost;
    return {
      inputTokens: Math.max(0, t.input),
      outputTokens: Math.max(0, t.output + t.reasoning),
      cacheReadTokens: Math.max(0, t.cache.read),
      cacheWriteTokens: Math.max(0, t.cache.write),
      ...(cost > 0 ? { costUsd: cost } : {}),
    };
  }
}
