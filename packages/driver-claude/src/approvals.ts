import type { ApprovalDecision, NormalizedEvent } from "@tide/contracts";
import { deferred, type Deferred } from "./async-queue.ts";
import { isDiffTool, previewDiff } from "./edit-preview.ts";
import type { AskUserQuestionInputShape } from "./sdk-shapes.ts";

export type PermissionResultShape =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] }
  | { behavior: "deny"; message: string; interrupt?: boolean };

export interface CanUseToolContext {
  signal?: AbortSignal;
  toolUseID: string;
  title?: string;
  description?: string;
  decisionReason?: string;
  suggestions?: unknown[];
}

const DENY_MESSAGE = "Declined by user in Tide";

/**
 * Tide never lets the harness flip from planning into execution: allowing `ExitPlanMode`
 * is what makes Claude Code start implementing. We capture the plan markdown as a
 * `ProposedPlan` and deny, so the turn ends in plan mode. The user promotes the plan to a
 * new thread from Tide (CLAUDE.md §4 "Never auto-execute a plan").
 */
export const EXIT_PLAN_DENY_MESSAGE =
  "Plan recorded in Tide. Stop here; the user will decide whether to implement it in a new thread.";

export class ApprovalBroker {
  #emit: (event: NormalizedEvent) => void;
  #approvals = new Map<string, Deferred<ApprovalDecision>>();
  #userInputs = new Map<string, Deferred<Record<string, unknown>>>();

  constructor(emit: (event: NormalizedEvent) => void) {
    this.#emit = emit;
  }

  async handle(toolName: string, input: Record<string, unknown>, context: CanUseToolContext): Promise<PermissionResultShape> {
    if (toolName === "ExitPlanMode") {
      const plan = typeof input["plan"] === "string" ? input["plan"] : "";
      this.#emit({ type: "plan.proposed", markdown: plan });
      return { behavior: "deny", message: EXIT_PLAN_DENY_MESSAGE };
    }
    if (toolName === "AskUserQuestion") return this.#askUserQuestion(input, context);
    return this.#approval(toolName, input, context);
  }

  async #approval(toolName: string, input: Record<string, unknown>, context: CanUseToolContext): Promise<PermissionResultShape> {
    const requestId = context.toolUseID;
    const diff = isDiffTool(toolName) ? previewDiff(toolName, input) : undefined;
    this.#emit({
      type: "activity",
      activity: {
        kind: "approval",
        requestId,
        toolName,
        input,
        status: "pending",
        ...(context.title ? { title: context.title } : {}),
        ...(context.description ?? context.decisionReason ? { description: context.description ?? context.decisionReason! } : {}),
        ...(diff ? { diff } : {}),
      },
    });

    const decision = await this.#await(this.#approvals, requestId, context.signal, "decline");
    switch (decision) {
      case "accept":
        return { behavior: "allow", updatedInput: input };
      case "acceptForSession":
        return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }] };
      case "acceptAlways":
        return { behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "localSettings" }] };
      case "cancel":
        return { behavior: "deny", message: DENY_MESSAGE, interrupt: true };
      default:
        return { behavior: "deny", message: DENY_MESSAGE };
    }
  }

  async #askUserQuestion(input: Record<string, unknown>, context: CanUseToolContext): Promise<PermissionResultShape> {
    const requestId = context.toolUseID;
    const asked = input as unknown as AskUserQuestionInputShape;
    const questions = Array.isArray(asked.questions) ? asked.questions : [];
    this.#emit({
      type: "activity",
      activity: {
        kind: "user-input",
        requestId,
        status: "pending",
        questions: questions.map((question, index) => ({
          id: `q${index}`,
          text: question.question,
          options: (question.options ?? []).map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
          ...(question.multiSelect === true ? { multi: true } : {}),
        })),
      },
    });

    const answers = await this.#await(this.#userInputs, requestId, context.signal, {});
    const collected: Record<string, string | string[]> = {};
    questions.forEach((question, index) => {
      const raw = answers[`q${index}`] ?? answers[question.question];
      if (typeof raw === "string") collected[question.question] = raw;
      else if (Array.isArray(raw)) collected[question.question] = raw.filter((v): v is string => typeof v === "string");
    });
    if (Object.keys(collected).length === 0) return { behavior: "deny", message: DENY_MESSAGE };
    // `answers` is a real (optional) field of AskUserQuestion's input schema — see sdk-shapes.ts.
    return { behavior: "allow", updatedInput: { ...input, answers: collected } };
  }

  async #await<T>(map: Map<string, Deferred<T>>, requestId: string, signal: AbortSignal | undefined, onAbort: T): Promise<T> {
    const pending = deferred<T>();
    map.set(requestId, pending);
    const abort = () => {
      map.delete(requestId);
      pending.resolve(onAbort);
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      return await pending.promise;
    } finally {
      signal?.removeEventListener("abort", abort);
      map.delete(requestId);
    }
  }

  respondApproval(requestId: string, decision: ApprovalDecision): void {
    this.#approvals.get(requestId)?.resolve(decision);
  }

  respondUserInput(requestId: string, answers: Record<string, unknown>): void {
    this.#userInputs.get(requestId)?.resolve(answers);
  }

  /** Releases every blocked callback so a closing session cannot hang the CLI. */
  cancelAll(): void {
    for (const pending of this.#approvals.values()) pending.resolve("cancel");
    for (const pending of this.#userInputs.values()) pending.resolve({});
    this.#approvals.clear();
    this.#userInputs.clear();
  }
}
