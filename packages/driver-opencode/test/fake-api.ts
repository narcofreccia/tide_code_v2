import { AsyncQueue } from "../src/async-queue.ts";
import type { OpencodeApi, PromptFile } from "../src/types.ts";
import type {
  FormValue,
  ModelRef,
  OpencodeEvent,
  PermissionReply,
  PermissionRule,
  WireAgent,
  WireConfigEntry,
  WireFormField,
  WireMessage,
  WireModel,
  WireSession,
  WireTokens,
} from "../src/wire.ts";

const ZERO: WireTokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

/** In-memory stand-in for an OpenCode 2 server; tests drive its (server-wide) event stream. */
export class FakeOpencodeApi implements OpencodeApi {
  #stream = new AsyncQueue<OpencodeEvent>();
  #streamError: Error | undefined;
  #seq = 0;
  readonly created: Parameters<OpencodeApi["createSession"]>[0][] = [];
  readonly prompts: { sessionId: string; text: string; files?: PromptFile[]; delivery?: "steer" | "queue" }[] = [];
  /** the session's messages, oldest first; prompts append `user`, `succeeded()` appends `idle` */
  messageLog: WireMessage[] = [];
  /** answer prompts without the admitted message (an older server) */
  promptWithoutId = false;
  readonly forks: { sessionId: string; before?: string }[] = [];
  forkDirectory = "/repo";
  forkError: Error | undefined;
  readonly moves: { sessionId: string; directory: string }[] = [];
  /** the directory a move actually lands in (default: where it was asked to go) */
  moveLandsIn: string | undefined;
  readonly waits: string[] = [];
  readonly removed: string[] = [];
  readonly reverts: { sessionId: string; messageId: string; files: boolean }[] = [];
  commits = 0;
  revertError: Error | undefined;
  #locations = new Map<string, string>();
  #messageSeq = 0;
  readonly permissionReplies: { requestId: string; decision: PermissionReply }[] = [];
  readonly formReplies: { formId: string; answer: Record<string, FormValue> }[] = [];
  readonly rulesets: { sessionId: string; permissions: PermissionRule[] }[] = [];
  readonly agentSwitches: string[] = [];
  readonly modelSwitches: ModelRef[] = [];
  readonly instructions: { key: string; value: unknown }[] = [];
  readonly mcp: { directory: string; name: string; command: string[] }[] = [];
  readonly mcpRemoved: { directory: string; name: string }[] = [];
  interrupts = 0;
  subscribes = 0;
  sessionId = "ses_fake";
  promptError: Error | undefined;
  switchError: Error | undefined;
  existing: Partial<WireSession> = {};
  configEntries: WireConfigEntry[] = [];
  configError: Error | undefined;
  modelList: WireModel[] = [
    { id: "big-pickle", providerID: "opencode", name: "Big Pickle", enabled: true, limit: { context: 200_000 } },
    { id: "small", providerID: "opencode", name: "Small", enabled: true },
  ];
  defaultModelValue: WireModel | undefined = { id: "big-pickle", providerID: "opencode", name: "Big Pickle", limit: { context: 200_000 } };
  agentList: WireAgent[] = [
    { id: "build", name: "Build", mode: "primary", hidden: false },
    { id: "plan", name: "Plan", mode: "primary", hidden: false },
    { id: "explore", name: "Explore", mode: "subagent", hidden: false },
    { id: "title", name: "Title", mode: "primary", hidden: true },
  ];

  get events(): AsyncQueue<OpencodeEvent> {
    return this.#stream;
  }

  async createSession(input: Parameters<OpencodeApi["createSession"]>[0]): Promise<WireSession> {
    this.created.push(input);
    return { id: this.sessionId, projectID: "p", cost: 0, tokens: ZERO, location: { directory: input.directory } };
  }

  async getSession(input: { sessionId: string }): Promise<WireSession> {
    return { id: input.sessionId, projectID: "p", cost: 0, tokens: ZERO, location: { directory: this.#locations.get(input.sessionId) ?? "/repo" }, ...this.existing };
  }

  async setPermissions(input: { sessionId: string; permissions: PermissionRule[] }): Promise<void> {
    if (this.switchError) throw this.switchError;
    this.rulesets.push(input);
  }

  async switchAgent(input: { agent: string }): Promise<void> {
    if (this.switchError) throw this.switchError;
    this.agentSwitches.push(input.agent);
  }

  async switchModel(input: { model: ModelRef }): Promise<void> {
    if (this.switchError) throw this.switchError;
    this.modelSwitches.push(input.model);
  }

  async putInstruction(input: { key: string; value: unknown }): Promise<void> {
    this.instructions.push({ key: input.key, value: input.value });
  }

  async prompt(input: { sessionId: string; text: string; files?: PromptFile[]; delivery?: "steer" | "queue" }): Promise<{ id?: string } | undefined> {
    if (this.promptError) throw this.promptError;
    this.prompts.push(input);
    const id = `msg_u${++this.#messageSeq}`;
    this.messageLog.push({ id, type: "user" });
    return this.promptWithoutId ? {} : { id };
  }

  /** Newest first; the cursor is the index to continue from. */
  async messages(input: { sessionId: string; limit: number; cursor?: string }): Promise<{ data: WireMessage[]; cursor?: { next?: string | null } }> {
    const newest = [...this.messageLog].reverse();
    const start = input.cursor === undefined ? 0 : Number(input.cursor);
    const data = newest.slice(start, start + input.limit);
    return { data, cursor: { next: String(start + data.length) } };
  }

  async fork(input: { sessionId: string; before?: string }): Promise<WireSession> {
    if (this.forkError) throw this.forkError;
    this.forks.push(input);
    const id = `ses_fork${this.forks.length}`;
    this.#locations.set(id, this.forkDirectory);
    return { id, projectID: "p", cost: 0, tokens: ZERO, location: { directory: this.forkDirectory } };
  }

  async moveSession(input: { sessionId: string; directory: string }): Promise<void> {
    this.moves.push(input);
    this.#locations.set(input.sessionId, this.moveLandsIn ?? input.directory);
  }

  async waitIdle(input: { sessionId: string }): Promise<void> {
    this.waits.push(input.sessionId);
  }

  async removeSession(input: { sessionId: string }): Promise<void> {
    this.removed.push(input.sessionId);
  }

  async revertStage(input: { sessionId: string; messageId: string; files: boolean }): Promise<void> {
    if (this.revertError) throw this.revertError;
    if (!this.messageLog.some((message) => message.id === input.messageId)) throw new Error("opencode POST /revert/stage failed: HTTP 404 message not found");
    this.reverts.push(input);
  }

  /** Deletes from the staged boundary on, like the 2.0.27 projector (`seq >= boundary`). */
  async revertCommit(): Promise<void> {
    this.commits++;
    const staged = this.reverts.at(-1);
    const index = staged === undefined ? -1 : this.messageLog.findIndex((message) => message.id === staged.messageId);
    if (index !== -1) this.messageLog = this.messageLog.slice(0, index);
  }

  async interrupt(): Promise<void> {
    this.interrupts++;
  }

  async replyPermission(input: { requestId: string; decision: PermissionReply }): Promise<void> {
    this.permissionReplies.push({ requestId: input.requestId, decision: input.decision });
  }

  async replyForm(input: { formId: string; answer: Record<string, FormValue> }): Promise<void> {
    this.formReplies.push({ formId: input.formId, answer: input.answer });
  }

  async cancelForm(): Promise<void> {}

  async subscribe(input: { signal: AbortSignal }): Promise<AsyncIterable<OpencodeEvent>> {
    this.subscribes++;
    if (this.subscribes > 1) {
      this.#stream = new AsyncQueue<OpencodeEvent>();
      this.#streamError = undefined;
    }
    const queue = this.#stream;
    input.signal.addEventListener("abort", () => queue.close(), { once: true });
    const self = this;
    return (async function* () {
      yield* queue.drain();
      if (self.#streamError && self.#stream === queue) throw self.#streamError;
    })();
  }

  /** Kills the live SSE stream the way a dead server does. */
  failStream(error = new Error("connection reset")): void {
    this.#streamError = error;
    this.#stream.close();
  }

  async models(): Promise<WireModel[]> {
    return this.modelList;
  }

  async defaultModel(): Promise<WireModel | undefined> {
    return this.defaultModelValue;
  }

  async agents(): Promise<WireAgent[]> {
    return this.agentList;
  }

  async config(): Promise<WireConfigEntry[]> {
    if (this.configError) throw this.configError;
    return this.configEntries;
  }

  async addMcpServer(input: { directory: string; name: string; command: string[] }): Promise<void> {
    this.mcp.push({ directory: input.directory, name: input.name, command: input.command });
  }

  async removeMcpServer(input: { directory: string; name: string }): Promise<void> {
    this.mcpRemoved.push(input);
  }

  async info(): Promise<{ version: string; pid: number }> {
    return { version: "2.0.27", pid: 1 };
  }

  // --- event helpers (shapes as recorded from opencode 2.0.27) ---
  emit(type: string, data: Record<string, unknown>, created = ++this.#seq): void {
    this.events.push({ id: `evt_${created}`, created, type, data: { sessionID: this.sessionId, ...data } } as unknown as OpencodeEvent);
  }

  step(agent = "build"): void {
    this.emit("session.step.started", { assistantMessageID: "msg_1", agent, model: { id: "big-pickle", providerID: "opencode" }, started: 1 });
  }

  text(messageId: string, delta: string, ordinal = 0): void {
    this.emit("session.text.delta", { assistantMessageID: messageId, ordinal, delta });
  }

  textEnded(messageId: string, text: string, ordinal = 0): void {
    this.emit("session.text.ended", { assistantMessageID: messageId, ordinal, text });
  }

  toolStart(id: string, name: string, input: Record<string, unknown>, created?: number): void {
    this.emit("session.tool.input.started", { assistantMessageID: "msg_1", id, name });
    this.emit("session.tool.called", { assistantMessageID: "msg_1", id, input, executed: false }, created);
  }

  toolSuccess(id: string, text: string, created?: number): void {
    this.emit("session.tool.success", { assistantMessageID: "msg_1", id, content: [{ type: "text", text }], executed: false }, created);
  }

  permissionAsked(id: string, action: string, resources: string[], extra: Record<string, unknown> = {}): void {
    this.emit("permission.asked", { id, action, resources, ...extra });
  }

  formCreated(id: string, fields: WireFormField[]): void {
    this.emit("form.created", { form: { id, sessionID: this.sessionId, title: "Questions", metadata: { kind: "question" }, fields } });
  }

  stepEnded(tokens: WireTokens, cost = 0): void {
    this.emit("session.step.ended", { assistantMessageID: "msg_1", finish: "stop", cost, tokens });
  }

  usage(tokens: WireTokens, cost = 0): void {
    this.emit("session.usage.updated", { cost, tokens });
  }

  succeeded(): void {
    this.messageLog.push({ id: `msg_i${++this.#messageSeq}`, type: "idle" });
    this.emit("session.execution.succeeded", {});
  }
}
