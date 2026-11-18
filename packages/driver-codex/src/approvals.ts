import type { ApprovalDecision, NormalizedEvent } from "@tide/contracts";
import { deferred, type Deferred } from "./async-queue.ts";
import { truncate } from "./items.ts";
import { rawPayload } from "./normalize.ts";
import type { RequestId } from "./jsonrpc.ts";
import { elicitationForm, type FormQuestion } from "./elicitation.ts";
import type { ToolRequestUserInputParams } from "./generated/v2/ToolRequestUserInputParams.ts";

/**
 * Codex's own decision vocabulary matches Tide's, except that it has no persistent
 * "always" grant on these requests — `acceptAlways` therefore lands on `acceptForSession`.
 */
function codexDecision(decision: ApprovalDecision): "accept" | "acceptForSession" | "decline" | "cancel" {
  return decision === "acceptAlways" ? "acceptForSession" : decision;
}

export interface ApprovalReply {
  /** JSON-RPC result to send back on the parked server request */
  result: unknown;
}

interface PendingApproval {
  gate: Deferred<ApprovalDecision>;
  reply: (decision: ApprovalDecision) => unknown;
  /** the card as emitted, so a withdrawn request can close it */
  card: NormalizedEvent;
}

interface PendingUserInput {
  gate: Deferred<Record<string, unknown>>;
  card: NormalizedEvent;
}

export interface ServerRequestContext {
  method: string;
  params: Record<string, unknown>;
  id: RequestId;
  /** diff last reported for the item, when the request is a file change */
  diffFor: (itemId: string) => string | undefined;
  /** set when the request comes from a sub-agent thread: the card nests under that child row */
  parentToolUseId?: string | undefined;
  /** a sub-agent's name, set when its card cannot nest under its row: shown in the card's title */
  requester?: string | undefined;
}

/**
 * Parks each server->client approval / user-input request as a Tide activity and answers
 * the JSON-RPC id once the user decides. `requestId` is the stringified JSON-RPC id, which
 * is what the reactor uses as the activity key.
 */
export class ApprovalBroker {
  #emit: (event: NormalizedEvent) => void;
  #respond: (id: RequestId, result: unknown) => void;
  #respondError: (id: RequestId, code: number, message: string) => void;
  #onSettled: (requestId: string) => void;
  #approvals = new Map<string, PendingApproval>();
  #userInputs = new Map<string, PendingUserInput>();

  /** `onSettled` runs once per parked request, after it was answered or withdrawn. */
  constructor(
    emit: (event: NormalizedEvent) => void,
    respond: (id: RequestId, result: unknown) => void,
    respondError: (id: RequestId, code: number, message: string) => void,
    onSettled: (requestId: string) => void = () => undefined,
  ) {
    this.#emit = emit;
    this.#respond = respond;
    this.#respondError = respondError;
    this.#onSettled = onSettled;
  }

  /** Whether a parked request still waits for the user. */
  isPending(requestId: string): boolean {
    return this.#approvals.has(requestId) || this.#userInputs.has(requestId);
  }

  /** True when the request was recognised and is now awaiting the user. */
  handle(context: ServerRequestContext): boolean {
    switch (context.method) {
      case "item/commandExecution/requestApproval":
        return this.#approval(context, "Bash", (params) => ({
          command: params["command"],
          cwd: params["cwd"],
          // 0.162: `writeStdin` = input typed into an existing terminal, not a new command
          ...(params["kind"] === "writeStdin" ? { kind: "writeStdin" } : {}),
          ...(params["reason"] ? { reason: params["reason"] } : {}),
        }));
      case "item/fileChange/requestApproval":
        return this.#approval(context, "Edit", (params) => ({
          ...(params["reason"] ? { reason: params["reason"] } : {}),
          ...(params["grantRoot"] ? { grantRoot: params["grantRoot"] } : {}),
        }));
      case "item/permissions/requestApproval":
        return this.#permissions(context);
      case "mcpServer/elicitation/request":
        return this.#elicitation(context);
      case "item/tool/requestUserInput":
        return this.#userInput(context);
      default:
        return false;
    }
  }

  #park(context: ServerRequestContext, activity: NormalizedEvent, reply: (decision: ApprovalDecision) => unknown): boolean {
    const requestId = String(context.id);
    const gate = deferred<ApprovalDecision>();
    const card = withParent(activity, context.parentToolUseId);
    this.#approvals.set(requestId, { gate, reply, card });
    this.#emit(card);
    void gate.promise.then((decision) => {
      if (this.#approvals.get(requestId)?.gate !== gate) return; // withdrawn meanwhile
      this.#approvals.delete(requestId);
      this.#respond(context.id, reply(decision));
      this.#onSettled(requestId);
    });
    return true;
  }

  #approval(context: ServerRequestContext, toolName: string, input: (params: Record<string, unknown>) => unknown): boolean {
    const itemId = typeof context.params["itemId"] === "string" ? context.params["itemId"] : undefined;
    const diff = itemId !== undefined ? context.diffFor(itemId) : undefined;
    return this.#park(
      context,
      {
        type: "activity",
        activity: {
          kind: "approval",
          requestId: String(context.id),
          toolName,
          input: input(context.params),
          status: "pending",
          ...(context.requester !== undefined ? { title: `${toolName} (sub-agent "${context.requester}")` } : {}),
          ...(typeof context.params["reason"] === "string" ? { description: truncate(context.params["reason"], 500) } : {}),
          ...(diff ? { diff: truncate(diff, 16_000) } : {}),
        },
      },
      (decision) => ({ decision: codexDecision(decision) }),
    );
  }

  #permissions(context: ServerRequestContext): boolean {
    const permissions = context.params["permissions"];
    return this.#park(
      context,
      {
        type: "activity",
        activity: {
          kind: "approval",
          requestId: String(context.id),
          toolName: "Permission",
          input: { permissions, cwd: context.params["cwd"] },
          status: "pending",
          ...(typeof context.params["reason"] === "string" ? { description: truncate(context.params["reason"], 500) } : {}),
        },
      },
      // An empty grant is how this request is denied: there is no decision enum for it.
      (decision) =>
        decision === "decline" || decision === "cancel"
          ? { permissions: {}, scope: "turn" }
          : { permissions: permissions ?? {}, scope: decision === "accept" ? "turn" : "session" },
    );
  }

  /**
   * A form-mode elicitation becomes a `UserInputActivity` built from the schema's top-level
   * fields; `respondUserInput` answers it (no answers = cancel). URL flows, and schemas with
   * nothing renderable, stay an accept/decline approval card.
   */
  #elicitation(context: ServerRequestContext): boolean {
    const form = elicitationForm(context.params);
    if (form) {
      return this.#askQuestions(context, form.questions, (answers) => {
        const content = form.toContent(answers);
        return content ? { action: "accept", content, _meta: null } : { action: "cancel", content: null, _meta: null };
      });
    }
    return this.#park(
      context,
      {
        type: "activity",
        activity: {
          kind: "approval",
          requestId: String(context.id),
          toolName: `mcp:${String(context.params["serverName"] ?? "server")}`,
          input: { message: context.params["message"], mode: context.params["mode"], url: context.params["url"] },
          status: "pending",
          ...(typeof context.params["message"] === "string" ? { description: truncate(context.params["message"], 500) } : {}),
        },
      },
      (decision) => ({ action: decision === "cancel" ? "cancel" : decision === "decline" ? "decline" : "accept", content: null, _meta: null }),
    );
  }

  #userInput(context: ServerRequestContext): boolean {
    const params = context.params as unknown as ToolRequestUserInputParams;
    const questions = Array.isArray(params.questions) ? params.questions : [];
    return this.#askQuestions(
      context,
      questions.map((question) => ({
        id: question.id,
        text: question.question,
        ...(question.options ? { options: question.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })) } : {}),
      })),
      (answers) => ({ answers: toCodexAnswers(questions, answers) }),
    );
  }

  #askQuestions(context: ServerRequestContext, questions: FormQuestion[], reply: (answers: Record<string, unknown>) => unknown): boolean {
    const requestId = String(context.id);
    const gate = deferred<Record<string, unknown>>();
    const card = withParent({ type: "activity", activity: { kind: "user-input", requestId, status: "pending", questions } }, context.parentToolUseId);
    this.#userInputs.set(requestId, { gate, card });
    this.#emit(card);
    void gate.promise.then((answers) => {
      if (this.#userInputs.get(requestId)?.gate !== gate) return; // withdrawn meanwhile
      this.#userInputs.delete(requestId);
      this.#respond(context.id, reply(answers));
      this.#onSettled(requestId);
    });
    return true;
  }

  respondApproval(requestId: string, decision: ApprovalDecision): void {
    this.#approvals.get(requestId)?.gate.resolve(decision);
  }

  respondUserInput(requestId: string, answers: Record<string, unknown>): void {
    this.#userInputs.get(requestId)?.gate.resolve(answers);
  }

  /** Releases every parked request so a closing session cannot hang the app-server. */
  cancelAll(): void {
    for (const pending of [...this.#approvals.values()]) pending.gate.resolve("cancel");
    for (const pending of [...this.#userInputs.values()]) pending.gate.resolve({});
  }

  /**
   * Codex resolved a request nobody answered (`serverRequest/resolved`: its turn ended or was
   * interrupted). The card is closed and nothing is sent back. False when the request was not
   * parked here, or was already answered.
   */
  withdraw(requestId: string): boolean {
    const approval = this.#approvals.get(requestId);
    const input = this.#userInputs.get(requestId);
    const card = approval?.card ?? input?.card;
    if (card === undefined || card.type !== "activity") return false;
    this.#approvals.delete(requestId);
    this.#userInputs.delete(requestId);
    const activity = card.activity;
    if (activity.kind === "approval") this.#emit({ type: "activity", activity: { ...activity, status: "resolved", decision: "cancel" } });
    else if (activity.kind === "user-input") this.#emit({ type: "activity", activity: { ...activity, status: "resolved" } });
    this.#onSettled(requestId);
    return true;
  }

  /**
   * Answers a server request Tide does not model, so the app-server is never left waiting,
   * and shows a pass-through row. Requests whose response type has a "no" are declined in
   * kind (a dynamic tool call fails, a legacy approval is denied); the rest get a
   * method-not-found error.
   */
  decline(id: RequestId, method: string, params: unknown): void {
    this.#emit({ type: "activity", activity: { kind: "info", text: `codex: ${method} (declined, not handled by Tide)`, payload: rawPayload(params) } });
    const note = `Tide does not handle ${method}`;
    switch (method) {
      case "item/tool/call":
        this.#respond(id, { success: false, contentItems: [{ type: "inputText", text: note }] });
        return;
      case "applyPatchApproval":
      case "execCommandApproval":
        this.#respond(id, { decision: { denied: { rejection: note } } });
        return;
      default:
        this.#respondError(id, -32601, note);
    }
  }
}

function withParent(event: NormalizedEvent, parentToolUseId: string | undefined): NormalizedEvent {
  if (parentToolUseId === undefined || event.type !== "activity") return event;
  return { ...event, activity: { ...event.activity, parentToolUseId } };
}

/** Tide answers are keyed by question id and valued by option label(s); Codex wants `{answers: string[]}`. */
export function toCodexAnswers(questions: ToolRequestUserInputParams["questions"], answers: Record<string, unknown>): Record<string, { answers: string[] }> {
  const result: Record<string, { answers: string[] }> = {};
  for (const question of questions) {
    const raw = answers[question.id];
    const values = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((value): value is string => typeof value === "string") : [];
    if (values.length > 0) result[question.id] = { answers: values };
  }
  return result;
}
