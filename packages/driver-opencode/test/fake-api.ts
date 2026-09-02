import { AsyncQueue } from "../src/async-queue.ts";
import type { ModelRef, OpencodeApi, PromptPart } from "../src/types.ts";
import type { OpencodeEvent, PermissionReply, PermissionRule, WireAgent, WireConfig, WireProvider } from "../src/wire.ts";

export interface PromptCall {
  directory: string;
  sessionId: string;
  agent: string;
  model?: ModelRef;
  system?: string;
  parts: PromptPart[];
}

/** In-memory stand-in for a running `opencode serve`; the tests drive its event stream. */
export class FakeOpencodeApi implements OpencodeApi {
  /**
   * One queue per subscription, the way a real SSE connection works: a stream that has ended
   * stays ended, and resubscribing gets a fresh one. `events` is always the newest.
   */
  #stream = new AsyncQueue<OpencodeEvent>();
  #streamError: Error | undefined;
  readonly mcpDisconnected: { directory: string; name: string }[] = [];

  get events(): AsyncQueue<OpencodeEvent> {
    return this.#stream;
  }
  readonly prompts: PromptCall[] = [];
  readonly permissions: { permissionId: string; reply: PermissionReply }[] = [];
  readonly answers: { requestId: string; answers: string[][] }[] = [];
  readonly mcp: { name: string; command: string[] }[] = [];
  readonly created: { directory: string; title?: string; permission?: PermissionRule[] }[] = [];
  aborts = 0;
  subscribes = 0;
  sessionId = "ses_fake";
  promptError: Error | undefined;
  configValue: WireConfig = {};
  /** set to make `GET /config` fail the way an older server does */
  configError: Error | undefined;
  providerCatalog: { providers: WireProvider[]; default: Record<string, string> } = {
    providers: [
      {
        id: "opencode",
        name: "OpenCode Zen",
        models: { "big-pickle": { id: "big-pickle", name: "Big Pickle", limit: { context: 200_000 } }, small: { id: "small", name: "Small" } },
      },
    ],
    default: { opencode: "big-pickle" },
  };
  agentList: WireAgent[] = [
    { name: "build", mode: "primary", builtIn: true },
    { name: "plan", mode: "primary", builtIn: true },
    { name: "explore", mode: "subagent", builtIn: true },
  ];

  async createSession(input: { directory: string; title?: string; permission?: PermissionRule[] }): Promise<{ id: string }> {
    this.created.push(input);
    return { id: this.sessionId };
  }

  async promptAsync(input: PromptCall): Promise<void> {
    if (this.promptError) throw this.promptError;
    this.prompts.push(input);
  }

  async abort(): Promise<void> {
    this.aborts++;
  }

  async respondPermission(input: { permissionId: string; reply: PermissionReply }): Promise<void> {
    this.permissions.push({ permissionId: input.permissionId, reply: input.reply });
  }

  async respondQuestion(input: { requestId: string; answers: string[][] }): Promise<void> {
    this.answers.push({ requestId: input.requestId, answers: input.answers });
  }

  async subscribe(input: { directory: string; signal: AbortSignal }): Promise<AsyncIterable<OpencodeEvent>> {
    this.subscribes++;
    if (this.subscribes > 1) {
      this.#stream = new AsyncQueue<OpencodeEvent>();
      this.#streamError = undefined;
    }
    const queue = this.#stream;
    // a real SSE stream ends when the caller aborts; close() waits for that
    input.signal.addEventListener("abort", () => queue.close(), { once: true });
    const self = this;
    return (async function* () {
      yield* queue.drain();
      if (self.#streamError && self.#stream === queue) throw self.#streamError;
    })();
  }

  /** Kills the live SSE stream the way a dropped connection does. */
  failStream(error = new Error("connection reset")): void {
    this.#streamError = error;
    this.#stream.close();
  }

  async providers(): Promise<{ providers: WireProvider[]; default: Record<string, string> }> {
    return this.providerCatalog;
  }

  async agents(): Promise<WireAgent[]> {
    return this.agentList;
  }

  async config(): Promise<WireConfig> {
    if (this.configError) throw this.configError;
    return this.configValue;
  }

  async addMcpServer(input: { name: string; command: string[] }): Promise<void> {
    this.mcp.push({ name: input.name, command: input.command });
  }

  async disconnectMcpServer(input: { directory: string; name: string }): Promise<void> {
    this.mcpDisconnected.push(input);
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    return { healthy: true, version: "1.1.36" };
  }

  // --- event helpers ---
  text(partId: string, messageId: string, text: string, delta?: string): void {
    this.events.push({ type: "message.part.updated", properties: { part: { id: partId, sessionID: this.sessionId, messageID: messageId, type: "text", text }, ...(delta !== undefined ? { delta } : {}) } });
  }

  tool(partId: string, callId: string, tool: string, state: Record<string, unknown>): void {
    this.events.push({ type: "message.part.updated", properties: { part: { id: partId, sessionID: this.sessionId, messageID: "msg_1", type: "tool", callID: callId, tool, state } as never } });
  }

  permissionAsked(id: string, permission: string, extra: Record<string, unknown> = {}): void {
    this.events.push({ type: "permission.asked", properties: { id, sessionID: this.sessionId, permission, patterns: ["*"], metadata: {}, always: [], ...extra } as never });
  }

  questionAsked(id: string, questions: { question: string; options?: { label: string; description?: string }[]; multiple?: boolean }[]): void {
    this.events.push({ type: "question.asked", properties: { id, sessionID: this.sessionId, questions } as never });
  }

  assistantDone(messageId: string, extra: Record<string, unknown> = {}): void {
    this.events.push({
      type: "message.updated",
      properties: {
        info: {
          id: messageId,
          sessionID: this.sessionId,
          role: "assistant",
          time: { created: 1, completed: 2 },
          tokens: { input: 10, output: 5, cache: { read: 3, write: 1 } },
          cost: 0.02,
          ...extra,
        },
      } as never,
    });
  }

  idle(): void {
    this.events.push({ type: "session.idle", properties: { sessionID: this.sessionId } });
  }
}
