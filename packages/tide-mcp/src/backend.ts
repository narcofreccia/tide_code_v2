import type { ScheduledTask, AgentCommand, RpcInput, RpcOutput } from "@tide/contracts";
import { TideConnection } from "@tide/client";

export type AgentContext = RpcOutput<"agent.context">;
export type AgentThreadStatus = RpcOutput<"agent.threadStatus">;
export type AgentDispatchResult = RpcOutput<"agent.dispatch">;
export type ThreadListInput = RpcInput<"agent.thread.list">;
export type ThreadListResult = RpcOutput<"agent.thread.list">;
export type ThreadReadInput = RpcInput<"agent.thread.read">;
export type ThreadReadResult = RpcOutput<"agent.thread.read">;
export type ThreadSendInput = RpcInput<"agent.thread.send">;
export type ThreadSendResult = RpcOutput<"agent.thread.send">;
export type ThreadWaitInput = RpcInput<"agent.thread.wait">;
export type ThreadWaitResult = RpcOutput<"agent.thread.wait">;
export type PendingListResult = RpcOutput<"agent.pending.list">;
export type PendingRespondInput = RpcInput<"agent.pending.respond">;
export type ThreadDiffInput = RpcInput<"agent.thread.diff">;
export type ThreadDiffResult = RpcOutput<"agent.thread.diff">;
export type SecretRequestInput = RpcInput<"agent.secret.request">;
export type SecretRequestResult = RpcOutput<"agent.secret.request">;

/** The slice of the Tide RPC surface the MCP tools need; faked in tests. */
export interface AgentBackend {
  dispatch(command: AgentCommand): Promise<AgentDispatchResult>;
  context(sinceMessageId?: string): Promise<AgentContext>;
  threadStatus(threadId: string): Promise<AgentThreadStatus>;
  threadList(input: ThreadListInput): Promise<ThreadListResult>;
  threadRead(input: ThreadReadInput): Promise<ThreadReadResult>;
  threadSend(input: ThreadSendInput): Promise<ThreadSendResult>;
  threadWait(input: ThreadWaitInput): Promise<ThreadWaitResult>;
  threadInterrupt(threadId: string): Promise<{ ok: boolean }>;
  threadDiff(input: ThreadDiffInput): Promise<ThreadDiffResult>;
  pendingList(threadId: string): Promise<PendingListResult>;
  taskList(): Promise<{ tasks: ScheduledTask[] }>;
  pendingRespond(input: PendingRespondInput): Promise<{ ok: boolean }>;
  /** R16: masked secret card on the caller's turn; resolves when the user answers */
  secretRequest(input: SecretRequestInput): Promise<SecretRequestResult>;
  close(): void;
}

export interface McpEnv {
  TIDE_SERVER_URL?: string | undefined;
  TIDE_AGENT_TOKEN?: string | undefined;
  TIDE_THREAD_ID?: string | undefined;
}

/**
 * Talks to the Tide server over the same WS RPC the web client uses, authenticated with
 * the thread's agent token (`?agentToken=`), which only unlocks the `agent.*` methods.
 */
export class TideAgentBackend implements AgentBackend {
  #connection: TideConnection;
  #ready: Promise<void> | undefined;

  constructor(options: { url: string; token: string; webSocketImpl?: typeof WebSocket }) {
    const url = new URL(options.url);
    url.searchParams.set("agentToken", options.token);
    this.#connection = new TideConnection({
      // the token already rides in the query string; the auth hook must not add another
      url: url.toString(),
      auth: { kind: "token", token: "" },
      ...(options.webSocketImpl !== undefined ? { webSocketImpl: options.webSocketImpl } : {}),
    });
  }

  async #connect(): Promise<void> {
    this.#ready ??= this.#connection.connect();
    await this.#ready;
  }

  async dispatch(command: AgentCommand): Promise<AgentDispatchResult> {
    await this.#connect();
    return this.#connection.call("agent.dispatch", { command });
  }

  async context(sinceMessageId?: string): Promise<AgentContext> {
    await this.#connect();
    return this.#connection.call("agent.context", sinceMessageId === undefined ? {} : { sinceMessageId });
  }

  async threadStatus(threadId: string): Promise<AgentThreadStatus> {
    await this.#connect();
    return this.#connection.call("agent.threadStatus", { threadId });
  }

  async threadList(input: ThreadListInput): Promise<ThreadListResult> {
    await this.#connect();
    return this.#connection.call("agent.thread.list", input);
  }

  async threadRead(input: ThreadReadInput): Promise<ThreadReadResult> {
    await this.#connect();
    return this.#connection.call("agent.thread.read", input);
  }

  async threadSend(input: ThreadSendInput): Promise<ThreadSendResult> {
    await this.#connect();
    return this.#connection.call("agent.thread.send", input);
  }

  async threadWait(input: ThreadWaitInput): Promise<ThreadWaitResult> {
    await this.#connect();
    return this.#connection.call("agent.thread.wait", input);
  }

  async threadInterrupt(threadId: string): Promise<{ ok: boolean }> {
    await this.#connect();
    return this.#connection.call("agent.thread.interrupt", { threadId });
  }

  async threadDiff(input: ThreadDiffInput): Promise<ThreadDiffResult> {
    await this.#connect();
    return this.#connection.call("agent.thread.diff", input);
  }

  async taskList(): Promise<{ tasks: ScheduledTask[] }> {
    await this.#connect();
    return this.#connection.call("agent.task.list", {});
  }

  async pendingList(threadId: string): Promise<PendingListResult> {
    await this.#connect();
    return this.#connection.call("agent.pending.list", { threadId });
  }

  async pendingRespond(input: PendingRespondInput): Promise<{ ok: boolean }> {
    await this.#connect();
    return this.#connection.call("agent.pending.respond", input);
  }

  async secretRequest(input: SecretRequestInput): Promise<SecretRequestResult> {
    await this.#connect();
    return this.#connection.call("agent.secret.request", input);
  }

  close(): void {
    this.#connection.close();
  }
}
