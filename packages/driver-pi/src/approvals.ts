import type { ApprovalDecision } from "@tide/contracts";
import { PLAN_PREFIX, USAGE_PREFIX, approvalDescription, parseApprovalMeta, parsePrefixedJson } from "@tide/pi-extensions/protocol";
import { deferred, type Deferred } from "./async-queue.ts";
import { isDiffTool, previewDiff } from "./edit-preview.ts";
import { displayToolName } from "./tool-names.ts";
import type { Emit, PiUiRequest } from "./types.ts";

/**
 * Translates pi's extension UI sub-protocol into Tide activities.
 *
 *  - `confirm` → an `approval` activity. The activity's `requestId` is pi's own
 *    `extension_ui_request.id`, because that is the value that has to come back in
 *    `extension_ui_response`. (`meta.requestId` is the extension's own counter, kept for log
 *    correlation.) A `TIDE_META:` first line carries the tool name, input and diff; a confirm
 *    from one of the user's own extensions has none, so its title becomes the tool name and
 *    the message becomes the description — it is still asked, never auto-declined.
 *  - `select` / `input` / `editor` (from any extension) → a `user-input` activity with one
 *    question; `respondUserInput` answers `extension_ui_response {value}` or `{cancelled}`
 *    (docs/rpc-extension-ui.md). pi's `ui_prompt_start`/`_end` are extension-runner events and
 *    never reach RPC stdout, so the dialog request itself is the signal.
 *  - `notify` starting with `TIDE_PLAN:` / `TIDE_USAGE:` → data, never rendered.
 *  - setStatus / setWidget / setTitle / set_editor_text → fire-and-forget chrome, ignored.
 *
 * `acceptForSession` / `acceptAlways` are remembered here, on the driver side, in
 * `#sessionAllow`: a later confirm for the same tool is answered `confirmed:true` without
 * surfacing an activity. Nothing extra crosses the wire, and the memory dies with the session
 * (`acceptAlways` is not persisted — Tide has no per-repo pi rule store in P4).
 */

export interface PlanPayload {
  plan: string;
}
export interface UsagePayload {
  tokens: number;
  contextWindow: number;
}

/** A pi dialog is one question; its answer comes back under this id. */
export const PI_QUESTION_ID = "answer";

function questionText(request: PiUiRequest): string {
  const title = request.title ?? request.method;
  if (request.method === "input" && request.placeholder) return `${title}\n(${request.placeholder})`;
  if (request.method === "editor" && request.prefill) return `${title}\n\nCurrent text:\n${request.prefill}`;
  return title;
}

/** Tide's answers → pi's dialog response. Empty / missing / unknown option → cancelled. */
export function dialogResponse(request: PiUiRequest, answers: Record<string, unknown>): Record<string, unknown> {
  const raw = answers[PI_QUESTION_ID] ?? Object.values(answers)[0];
  const value = Array.isArray(raw) ? raw.map(String).join(", ") : typeof raw === "string" ? raw : undefined;
  if (value === undefined || (request.method !== "editor" && value.trim() === "")) return { cancelled: true };
  if (request.method === "select" && request.options && !request.options.includes(value)) return { cancelled: true };
  return { value };
}

export class PiApprovalBroker {
  #emit: Emit;
  #respond: (id: string, body: Record<string, unknown>) => void;
  #cwd: string;
  #pending = new Map<string, Deferred<ApprovalDecision>>();
  #sessionAllow = new Set<string>();
  #dialogs = new Map<string, PiUiRequest>();

  constructor(emit: Emit, respond: (id: string, body: Record<string, unknown>) => void, cwd: string) {
    this.#emit = emit;
    this.#respond = respond;
    this.#cwd = cwd;
  }

  /** Routes one `extension_ui_request` (docs/rpc-extension-ui.md § Requests from Pi). */
  handle(request: PiUiRequest): void {
    if (request.method === "notify") return this.#notify(request.message ?? "");
    if (request.method === "confirm") return this.#confirm(request);
    if (request.method === "select" || request.method === "input" || request.method === "editor") return this.#dialog(request);
    // setStatus / setWidget / setTitle / set_editor_text: fire-and-forget chrome, ignored.
  }

  #dialog(request: PiUiRequest): void {
    this.#dialogs.set(request.id, request);
    const options = request.method === "select" ? (request.options ?? []).map((label) => ({ label })) : undefined;
    this.#emit({
      type: "activity",
      activity: {
        kind: "user-input",
        requestId: request.id,
        questions: [{ id: PI_QUESTION_ID, text: questionText(request), ...(options ? { options } : {}) }],
        status: "pending",
      },
    });
  }

  respondUserInput(requestId: string, answers: Record<string, unknown>): void {
    const request = this.#dialogs.get(requestId);
    if (!request) return;
    this.#dialogs.delete(requestId);
    this.#respond(requestId, dialogResponse(request, answers));
  }

  #notify(message: string): void {
    const plan = parsePrefixedJson<PlanPayload>(message, PLAN_PREFIX);
    if (plan && typeof plan.plan === "string") {
      this.#emit({ type: "plan.proposed", markdown: plan.plan });
      return;
    }
    const usage = parsePrefixedJson<UsagePayload>(message, USAGE_PREFIX);
    if (usage && typeof usage.tokens === "number" && typeof usage.contextWindow === "number" && usage.contextWindow > 0) {
      this.#emit({ type: "usage", contextUsage: { used: usage.tokens, window: usage.contextWindow } });
      return;
    }
    if (message.trim() !== "") this.#emit({ type: "activity", activity: { kind: "info", text: message } });
  }

  #confirm(request: PiUiRequest): void {
    const message = request.message ?? "";
    const meta = parseApprovalMeta(message);
    // A confirm from one of the user's own extensions. It is still a yes/no question aimed at
    // the user, so it becomes a normal approval card rather than a silent "no" — auto-declining
    // it broke every extension that asks anything (CLAUDE.md §1a: pass through, don't translate).
    const toolName = meta?.toolName ?? request.title ?? "pi";
    const shownName = meta ? displayToolName(meta.toolName) : toolName;
    if (this.#sessionAllow.has(toolName)) {
      this.#respond(request.id, { confirmed: true });
      return;
    }

    const input = meta ? meta.input : { message };
    const diff = meta ? (meta.diff ?? (isDiffTool(meta.toolName) ? previewDiff(meta.toolName, meta.input, this.#cwd) : undefined)) : undefined;
    const description = meta ? approvalDescription(message) : message.trim() === "" ? undefined : message;
    this.#emit({
      type: "activity",
      activity: {
        kind: "approval",
        requestId: request.id,
        toolName: shownName,
        input,
        status: "pending",
        ...(request.title ? { title: request.title } : {}),
        ...(description ? { description } : {}),
        ...(diff ? { diff } : {}),
      },
    });

    const pending = deferred<ApprovalDecision>();
    this.#pending.set(request.id, pending);
    void pending.promise.then((decision) => {
      this.#pending.delete(request.id);
      if (decision === "acceptForSession" || decision === "acceptAlways") this.#sessionAllow.add(toolName);
      const confirmed = decision === "accept" || decision === "acceptForSession" || decision === "acceptAlways";
      this.#respond(request.id, confirmed ? { confirmed: true } : { confirmed: false });
    });
  }

  respondApproval(requestId: string, decision: ApprovalDecision): void {
    this.#pending.get(requestId)?.resolve(decision);
  }

  /** Releases every blocked dialog so an interrupt or close cannot hang pi. */
  cancelAll(): void {
    for (const pending of this.#pending.values()) pending.resolve("cancel");
    this.#pending.clear();
    for (const id of this.#dialogs.keys()) this.#respond(id, { cancelled: true });
    this.#dialogs.clear();
  }

  get pendingCount(): number {
    return this.#pending.size + this.#dialogs.size;
  }
}
