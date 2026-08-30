import type { ApprovalDecision } from "@tide/contracts";
import { PLAN_PREFIX, USAGE_PREFIX, approvalDescription, parseApprovalMeta, parsePrefixedJson } from "@tide/pi-extensions/protocol";
import { deferred, type Deferred } from "./async-queue.ts";
import { isDiffTool, previewDiff } from "./edit-preview.ts";
import type { Emit, PiUiRequest } from "./types.ts";

/**
 * Translates pi's extension UI sub-protocol into Tide activities.
 *
 *  - `confirm` whose message starts with `TIDE_META:` → an `approval` activity. The activity's
 *    `requestId` is pi's own `extension_ui_request.id`, because that is the value that has to
 *    come back in `extension_ui_response`. (`meta.requestId` is the extension's own counter,
 *    kept for log correlation.)
 *  - `notify` starting with `TIDE_PLAN:` / `TIDE_USAGE:` → data, never rendered.
 *  - anything else → an info activity, and dialogs are cancelled so pi cannot block forever.
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

export class PiApprovalBroker {
  #emit: Emit;
  #respond: (id: string, body: Record<string, unknown>) => void;
  #cwd: string;
  #pending = new Map<string, Deferred<ApprovalDecision>>();
  #sessionAllow = new Set<string>();

  constructor(emit: Emit, respond: (id: string, body: Record<string, unknown>) => void, cwd: string) {
    this.#emit = emit;
    this.#respond = respond;
    this.#cwd = cwd;
  }

  /** Returns true when the request was consumed as Tide data rather than shown to the user. */
  handle(request: PiUiRequest): void {
    if (request.method === "notify") return this.#notify(request.message ?? "");
    if (request.method === "confirm") return this.#confirm(request);
    if (request.method === "select" || request.method === "input" || request.method === "editor") {
      // Not part of Tide's vocabulary; cancelling keeps pi moving instead of deadlocking.
      this.#emit({ type: "activity", activity: { kind: "info", text: `pi asked for ${request.method}: ${request.title ?? ""}`.trim() } });
      this.#respond(request.id, { cancelled: true });
      return;
    }
    // setStatus / setWidget / setTitle / set_editor_text: fire-and-forget chrome, ignored.
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
    if (!meta) {
      // A confirm from some other extension of the user's. Surface it, then decline: Tide has
      // no card for it yet, and answering "yes" on the user's behalf would be worse.
      this.#emit({ type: "activity", activity: { kind: "info", text: `pi asked: ${request.title ?? message}` } });
      this.#respond(request.id, { confirmed: false });
      return;
    }
    if (this.#sessionAllow.has(meta.toolName)) {
      this.#respond(request.id, { confirmed: true });
      return;
    }

    const diff = meta.diff ?? (isDiffTool(meta.toolName) ? previewDiff(meta.toolName, meta.input, this.#cwd) : undefined);
    const description = approvalDescription(message);
    this.#emit({
      type: "activity",
      activity: {
        kind: "approval",
        requestId: request.id,
        toolName: meta.toolName,
        input: meta.input,
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
      if (decision === "acceptForSession" || decision === "acceptAlways") this.#sessionAllow.add(meta.toolName);
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
  }

  get pendingCount(): number {
    return this.#pending.size;
  }
}
