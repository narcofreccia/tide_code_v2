import type { AgentCommand, RpcOutput } from "@tide/contracts";
import { TideConnection } from "@tide/client";

export type AgentContext = RpcOutput<"agent.context">;
export type AgentThreadStatus = RpcOutput<"agent.threadStatus">;
export type AgentDispatchResult = RpcOutput<"agent.dispatch">;

/** The slice of the Tide RPC surface the MCP tools need; faked in tests. */
export interface AgentBackend {
  dispatch(command: AgentCommand): Promise<AgentDispatchResult>;
  context(sinceMessageId?: string): Promise<AgentContext>;
  threadStatus(threadId: string): Promise<AgentThreadStatus>;
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

  close(): void {
    this.#connection.close();
  }
}
