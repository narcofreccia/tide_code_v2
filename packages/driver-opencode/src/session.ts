import type { ApprovalDecision, DriverEnv, NormalizedEvent, OpenSessionOptions, ProviderSession, TurnInput } from "@tide/contracts";
import { AsyncQueue } from "./async-queue.ts";
import { OpencodeNormalizer } from "./normalize.ts";
import { replyFor } from "./permissions.ts";
import type { ModelRef, OpencodeApi, PromptPart } from "./types.ts";
import type { OpencodeEvent, WirePermission, WireQuestionRequest } from "./wire.ts";

export interface SessionDeps {
  api: OpencodeApi;
  /** `plan` or `build` (or a user agent), decided by the instance from `interaction` */
  agent: string;
  model?: ModelRef;
  contextWindow?: number;
}

function promptParts(input: TurnInput): PromptPart[] {
  const parts: PromptPart[] = [];
  for (const [index, image] of (input.images ?? []).entries()) {
    parts.push({ type: "file", mime: image.mediaType, filename: `image-${index + 1}`, url: `data:${image.mediaType};base64,${image.data}` });
  }
  parts.push({ type: "text", text: input.text });
  return parts;
}

/**
 * One opencode session on the instance's server. Turns are strictly serial: opencode runs
 * one prompt per session and the SSE stream is the only completion signal, so `send()`
 * refuses a second concurrent turn instead of interleaving two `settled`s.
 */
export class OpencodeSession implements ProviderSession {
  nativeSessionId: string;

  #env: DriverEnv;
  #options: OpenSessionOptions;
  #deps: SessionDeps;
  #abort = new AbortController();
  #subscription: Promise<void> | undefined;
  #mailbox: AsyncQueue<NormalizedEvent> | undefined;
  #normalizer: OpencodeNormalizer | undefined;
  #questions = new Map<string, WireQuestionRequest>();
  #turnActive = false;
  #closed = false;

  constructor(env: DriverEnv, options: OpenSessionOptions, deps: SessionDeps, sessionId: string) {
    this.#env = env;
    this.#options = options;
    this.#deps = deps;
    this.nativeSessionId = sessionId;
  }

  get #directory(): string {
    return this.#options.cwd;
  }

  send(input: TurnInput): AsyncIterable<NormalizedEvent> {
    if (this.#closed) throw new Error("opencode session is closed");
    if (this.#turnActive) throw new Error("busy: a turn is already running on this opencode session");
    this.#turnActive = true;
    const mailbox = new AsyncQueue<NormalizedEvent>();
    this.#mailbox = mailbox;
    this.#normalizer = new OpencodeNormalizer({
      sessionId: this.nativeSessionId,
      agent: this.#deps.agent,
      ...(this.#deps.contextWindow !== undefined ? { contextWindow: this.#deps.contextWindow } : {}),
      onUnknown: (type) => {
        if (process.env["TIDE_DEBUG_OPENCODE"]) this.#env.log(`[opencode] unhandled event ${type}`);
      },
    });
    const self = this;

    async function* stream(): AsyncGenerator<NormalizedEvent, void> {
      const pump = self.#pump(mailbox, input);
      try {
        yield { type: "session", nativeSessionId: self.nativeSessionId, ...(self.#deps.model ? { model: `${self.#deps.model.providerID}/${self.#deps.model.modelID}` } : {}) };
        for await (const event of mailbox.drain()) yield event;
        await pump;
      } finally {
        self.#turnActive = false;
        self.#mailbox = undefined;
        self.#normalizer = undefined;
      }
    }
    return stream();
  }

  async #pump(mailbox: AsyncQueue<NormalizedEvent>, input: TurnInput): Promise<void> {
    try {
      // Subscribe before prompting: the stream is the only place a turn's events appear.
      await this.#ensureSubscription();
      await this.#deps.api.promptAsync({
        directory: this.#directory,
        sessionId: this.nativeSessionId,
        agent: this.#deps.agent,
        ...(this.#deps.model ? { model: this.#deps.model } : {}),
        ...(this.#options.systemPromptAppend !== undefined ? { system: this.#options.systemPromptAppend } : {}),
        parts: promptParts(input),
      });
    } catch (error) {
      mailbox.push({ type: "settled", status: "error", error: error instanceof Error ? error.message : String(error) });
      mailbox.close();
    }
  }

  async #ensureSubscription(): Promise<void> {
    if (this.#subscription !== undefined) return;
    const stream = await this.#deps.api.subscribe({ directory: this.#directory, signal: this.#abort.signal });
    this.#subscription = (async () => {
      try {
        for await (const event of stream) this.#onEvent(event);
      } catch (error) {
        if (this.#closed) return;
        this.#env.log(`[opencode] event stream ended: ${error instanceof Error ? error.message : String(error)}`);
        this.#mailbox?.push({ type: "settled", status: "error", error: "opencode event stream ended before the turn settled" });
        this.#mailbox?.close();
      }
    })();
  }

  #onEvent(event: OpencodeEvent): void {
    if (event.type === "question.asked") {
      const request = event.properties as unknown as WireQuestionRequest;
      if (request.sessionID === this.nativeSessionId) this.#questions.set(request.id, request);
    }
    if (event.type === "permission.asked" || event.type === "permission.updated") {
      const permission = event.properties as unknown as WirePermission;
      const kind = permission.permission ?? permission.type;
      // Tide never lets opencode flip from planning into editing (CLAUDE.md §4).
      if (permission.sessionID === this.nativeSessionId && kind === "plan_exit") void this.#reject(permission.id);
    }
    const events = this.#normalizer?.next(event) ?? [];
    const mailbox = this.#mailbox;
    if (!mailbox) return;
    for (const normalized of events) {
      mailbox.push(normalized);
      if (normalized.type === "settled") mailbox.close();
    }
  }

  async #reject(permissionId: string): Promise<void> {
    try {
      await this.#deps.api.respondPermission({ directory: this.#directory, sessionId: this.nativeSessionId, permissionId, reply: "reject" });
    } catch (error) {
      this.#env.log(`[opencode] auto-reject of ${permissionId} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async respondApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    await this.#deps.api.respondPermission({ directory: this.#directory, sessionId: this.nativeSessionId, permissionId: requestId, reply: replyFor(decision) });
  }

  /** `answers` is keyed by the question ids the driver minted (`q0`, `q1`, …); values are option labels. */
  async respondUserInput(requestId: string, answers: Record<string, unknown>): Promise<void> {
    const request = this.#questions.get(requestId);
    const questions = request?.questions ?? [];
    const payload = questions.map((_question, index) => {
      const answer = answers[`q${index}`];
      if (typeof answer === "string") return [answer];
      if (Array.isArray(answer)) return answer.filter((value): value is string => typeof value === "string");
      return [];
    });
    this.#questions.delete(requestId);
    await this.#deps.api.respondQuestion({ directory: this.#directory, requestId, answers: payload });
  }

  async interrupt(): Promise<void> {
    this.#normalizer?.markInterrupted();
    try {
      await this.#deps.api.abort({ directory: this.#directory, sessionId: this.nativeSessionId });
    } catch (error) {
      this.#env.log(`[opencode] abort failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#mailbox?.close();
    this.#abort.abort();
    await this.#subscription?.catch(() => undefined);
  }
}
