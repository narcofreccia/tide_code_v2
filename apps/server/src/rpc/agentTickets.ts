import { randomBytes } from "node:crypto";

/**
 * Long-lived per-thread tokens handed to the agent processes Tide spawns (through the
 * Tide MCP server's env). Unlike the browser's single-use ws tickets these survive for
 * the life of the harness session and are revoked when that session closes.
 */
export class AgentTokenStore {
  #byThread = new Map<string, string>();
  #byToken = new Map<string, string>();
  #mint: () => string;

  constructor(options: { mint?: () => string } = {}) {
    this.#mint = options.mint ?? (() => randomBytes(32).toString("hex"));
  }

  get size(): number {
    return this.#byThread.size;
  }

  /** Stable per thread: reopening a session reuses the token the agent already has. */
  getOrCreate(threadId: string): string {
    const existing = this.#byThread.get(threadId);
    if (existing !== undefined) return existing;
    const token = this.#mint();
    this.#byThread.set(threadId, token);
    this.#byToken.set(token, threadId);
    return token;
  }

  peek(threadId: string): string | undefined {
    return this.#byThread.get(threadId);
  }

  /** threadId the token authenticates, or undefined when unknown/revoked. */
  resolve(token: string): string | undefined {
    return this.#byToken.get(token);
  }

  revoke(threadId: string): void {
    const token = this.#byThread.get(threadId);
    if (token === undefined) return;
    this.#byThread.delete(threadId);
    this.#byToken.delete(token);
  }

  clear(): void {
    this.#byThread.clear();
    this.#byToken.clear();
  }
}
