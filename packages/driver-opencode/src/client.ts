import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { ModelRef, OpencodeApi, PromptPart } from "./types.ts";
import type { OpencodeEvent, PermissionReply, PermissionRule, WireAgent, WireConfig, WireProvider } from "./wire.ts";

interface SdkResult<T> {
  data?: T;
  error?: unknown;
}

function unwrap<T>(result: SdkResult<T>, what: string): NonNullable<T> {
  if (result.error !== undefined) throw new Error(`opencode ${what} failed: ${JSON.stringify(result.error)}`);
  if (result.data === undefined) throw new Error(`opencode ${what} returned no data`);
  return result.data as NonNullable<T>;
}

/**
 * `OpencodeApi` over `@opencode-ai/sdk`'s generated client.
 *
 * Two calls go out over raw `fetch` because they postdate the published SDK (verified
 * against `GET /doc` of opencode 1.1.36): `GET /global/health` and the question reply
 * route `POST /question/{id}/reply`. Session creation's `permission` ruleset is likewise
 * newer than the SDK's body type, so that one field is cast at this boundary.
 */
export class SdkOpencodeApi implements OpencodeApi {
  #client: OpencodeClient;
  #baseUrl: string;

  constructor(baseUrl: string) {
    this.#baseUrl = baseUrl.replace(/\/$/, "");
    this.#client = createOpencodeClient({ baseUrl: this.#baseUrl });
  }

  async createSession(input: { directory: string; title?: string; permission?: PermissionRule[] }): Promise<{ id: string }> {
    const body = { ...(input.title !== undefined ? { title: input.title } : {}), ...(input.permission ? { permission: input.permission } : {}) };
    const result = await this.#client.session.create({
      query: { directory: input.directory },
      body: body as { title?: string },
    });
    return unwrap(result, "session.create");
  }

  async promptAsync(input: { directory: string; sessionId: string; agent: string; model?: ModelRef; system?: string; parts: PromptPart[] }): Promise<void> {
    const result = await this.#client.session.promptAsync({
      path: { id: input.sessionId },
      query: { directory: input.directory },
      body: {
        agent: input.agent,
        ...(input.model ? { model: input.model } : {}),
        ...(input.system !== undefined ? { system: input.system } : {}),
        parts: input.parts as { type: "text"; text: string }[],
      },
    });
    unwrapVoid(result, "session.promptAsync");
  }

  async abort(input: { directory: string; sessionId: string }): Promise<void> {
    const result = await this.#client.session.abort({ path: { id: input.sessionId }, query: { directory: input.directory } });
    unwrapVoid(result, "session.abort");
  }

  async respondPermission(input: { directory: string; sessionId: string; permissionId: string; reply: PermissionReply }): Promise<void> {
    const result = await this.#client.postSessionIdPermissionsPermissionId({
      path: { id: input.sessionId, permissionID: input.permissionId },
      query: { directory: input.directory },
      body: { response: input.reply },
    });
    unwrapVoid(result, "permission reply");
  }

  async respondQuestion(input: { directory: string; requestId: string; answers: string[][] }): Promise<void> {
    await this.#post(`/question/${encodeURIComponent(input.requestId)}/reply?directory=${encodeURIComponent(input.directory)}`, { answers: input.answers });
  }

  async subscribe(input: { directory: string; signal: AbortSignal }): Promise<AsyncIterable<OpencodeEvent>> {
    const result = await this.#client.event.subscribe({ query: { directory: input.directory }, signal: input.signal });
    return result.stream as AsyncIterable<OpencodeEvent>;
  }

  async providers(): Promise<{ providers: WireProvider[]; default: Record<string, string> }> {
    const result = await this.#client.config.providers();
    return unwrap(result, "config.providers") as { providers: WireProvider[]; default: Record<string, string> };
  }

  async config(input: { directory: string }): Promise<WireConfig> {
    const result = await this.#client.config.get({ query: { directory: input.directory } });
    return unwrap(result, "config.get") as WireConfig;
  }

  async agents(input: { directory: string }): Promise<WireAgent[]> {
    const result = await this.#client.app.agents({ query: { directory: input.directory } });
    return unwrap(result, "app.agents") as WireAgent[];
  }

  async addMcpServer(input: { directory: string; name: string; command: string[]; env?: Record<string, string> }): Promise<void> {
    const result = await this.#client.mcp.add({
      query: { directory: input.directory },
      body: { name: input.name, config: { type: "local", command: input.command, enabled: true, ...(input.env ? { environment: input.env } : {}) } },
    });
    unwrapVoid(result, "mcp.add");
  }

  async disconnectMcpServer(input: { directory: string; name: string }): Promise<void> {
    const result = await this.#client.mcp.disconnect({ path: { name: input.name }, query: { directory: input.directory } });
    unwrapVoid(result, "mcp.disconnect");
  }

  async health(): Promise<{ healthy: boolean; version?: string }> {
    const response = await fetch(`${this.#baseUrl}/global/health`);
    if (!response.ok) throw new Error(`opencode health check failed: HTTP ${response.status}`);
    return (await response.json()) as { healthy: boolean; version?: string };
  }

  async #post(path: string, body: unknown): Promise<void> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`opencode POST ${path} failed: HTTP ${response.status}`);
  }
}

function unwrapVoid(result: SdkResult<unknown>, what: string): void {
  if (result.error !== undefined) throw new Error(`opencode ${what} failed: ${JSON.stringify(result.error)}`);
}
