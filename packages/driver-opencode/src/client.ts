import type { OpencodeApi, PromptFile } from "./types.ts";
import type {
  FormValue,
  ModelRef,
  OpencodeEvent,
  PermissionReply,
  PermissionRule,
  WireAgent,
  WireConfigEntry,
  WireModel,
  WireSession,
} from "./wire.ts";

export interface Endpoint {
  url: string;
  /** Basic auth password; the user name is always `opencode` (`@opencode/client` service-probe) */
  password?: string;
}

export function authHeader(endpoint: Endpoint): Record<string, string> {
  if (endpoint.password === undefined) return {};
  return { authorization: `Basic ${Buffer.from(`opencode:${endpoint.password}`).toString("base64")}` };
}

/** `?location[directory]=…` — the v2 API's deepObject location scoping. */
function located(directory: string): string {
  return `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
}

/**
 * `OpencodeApi` over the OpenCode 2 HTTP API with plain `fetch`.
 *
 * Why not the SDK's runtime: `@opencode/sdk` 2.x is an *in-process host* ("executes Server's
 * assembled HTTP router in memory, opening no listener" — its README). Using it would run a
 * second OpenCode engine inside Tide's server with its own (default in-memory) database —
 * not the user's shared service, not the sessions their TUI shows. The remote client lives
 * in `@opencode/client`; this file is the ~20 routes Tide needs, verified against
 * `GET /openapi.json` of `opencode serve` 2.0.27. Event types still come from the SDK.
 */
export class HttpOpencodeApi implements OpencodeApi {
  #endpoint: Endpoint;

  constructor(endpoint: Endpoint) {
    this.#endpoint = { ...endpoint, url: endpoint.url.replace(/\/$/, "") };
  }

  async #request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.#endpoint.url}${path}`, {
      method,
      headers: { ...authHeader(this.#endpoint), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`opencode ${method} ${path.split("?")[0]} failed: HTTP ${response.status} ${text.slice(0, 500)}`);
    if (text === "") return undefined as T;
    return JSON.parse(text) as T;
  }

  async #data<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.#request<{ data: T }>(method, path, body)).data;
  }

  createSession(input: { directory: string; title?: string; agent?: string; model?: ModelRef; permissions?: PermissionRule[]; metadata?: Record<string, unknown> }): Promise<WireSession> {
    const { directory, ...rest } = input;
    return this.#data("POST", "/api/session", { location: { directory }, ...rest });
  }

  getSession(input: { sessionId: string }): Promise<WireSession> {
    return this.#data("GET", `/api/session/${encodeURIComponent(input.sessionId)}`);
  }

  async setPermissions(input: { sessionId: string; permissions: PermissionRule[] }): Promise<void> {
    await this.#request("PATCH", `/api/session/${encodeURIComponent(input.sessionId)}`, { permissions: input.permissions });
  }

  async switchAgent(input: { sessionId: string; agent: string }): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(input.sessionId)}/agent`, { agent: input.agent });
  }

  async switchModel(input: { sessionId: string; model: ModelRef }): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(input.sessionId)}/model`, { model: input.model });
  }

  async putInstruction(input: { sessionId: string; key: string; value: unknown }): Promise<void> {
    await this.#request("PUT", `/api/experimental/session/${encodeURIComponent(input.sessionId)}/instructions/entries/${encodeURIComponent(input.key)}`, { value: input.value });
  }

  async prompt(input: { sessionId: string; text: string; files?: PromptFile[] }): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(input.sessionId)}/prompt`, {
      text: input.text,
      ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
    });
  }

  async interrupt(input: { sessionId: string }): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(input.sessionId)}/interrupt`);
  }

  async replyPermission(input: { sessionId: string; requestId: string; decision: PermissionReply; message?: string }): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(input.sessionId)}/permission/${encodeURIComponent(input.requestId)}/reply`, {
      decision: input.decision,
      ...(input.message !== undefined ? { message: input.message } : {}),
    });
  }

  async replyForm(input: { sessionId: string; formId: string; answer: Record<string, FormValue> }): Promise<void> {
    await this.#request("POST", `/api/session/${encodeURIComponent(input.sessionId)}/form/${encodeURIComponent(input.formId)}/reply`, { answer: input.answer });
  }

  async cancelForm(input: { sessionId: string; formId: string }): Promise<void> {
    await this.#request("DELETE", `/api/session/${encodeURIComponent(input.sessionId)}/form/${encodeURIComponent(input.formId)}`);
  }

  async subscribe(input: { signal: AbortSignal }): Promise<AsyncIterable<OpencodeEvent>> {
    const response = await fetch(`${this.#endpoint.url}/api/event`, { headers: { ...authHeader(this.#endpoint), accept: "text/event-stream" }, signal: input.signal });
    if (!response.ok || response.body === null) throw new Error(`opencode event stream failed: HTTP ${response.status}`);
    return parseSse(response.body);
  }

  models(input: { directory: string }): Promise<WireModel[]> {
    return this.#data("GET", `/api/model?${located(input.directory)}`);
  }

  async defaultModel(input: { directory: string }): Promise<WireModel | undefined> {
    return (await this.#data<WireModel | null>("GET", `/api/model/default?${located(input.directory)}`)) ?? undefined;
  }

  agents(input: { directory: string }): Promise<WireAgent[]> {
    return this.#data("GET", `/api/agent?${located(input.directory)}`);
  }

  config(input: { directory: string }): Promise<WireConfigEntry[]> {
    return this.#request("GET", `/api/config?${located(input.directory)}`);
  }

  async addMcpServer(input: { directory: string; name: string; command: string[]; env?: Record<string, string> }): Promise<void> {
    await this.#request("PUT", `/api/experimental/mcp/${encodeURIComponent(input.name)}?${located(input.directory)}`, {
      config: { type: "local", command: input.command, ...(input.env ? { environment: input.env } : {}) },
    });
  }

  async removeMcpServer(input: { directory: string; name: string }): Promise<void> {
    await this.#request("DELETE", `/api/experimental/mcp/${encodeURIComponent(input.name)}?${located(input.directory)}`);
  }

  info(): Promise<{ version: string; pid: number }> {
    return this.#request("GET", "/api/info");
  }
}

/**
 * Minimal SSE reader for `GET /api/event`: `data: <json>` lines, blank-line separated,
 * `:` comment heartbeats ignored. Unparseable frames are skipped rather than killing the stream.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<OpencodeEvent, void> {
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") {
        if (data.length > 0) {
          const event = parseFrame(data.join("\n"));
          data = [];
          if (event) yield event;
        }
        continue;
      }
      if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  const rest = buffer.replace(/\r$/, "");
  if (rest.startsWith("data:")) data.push(rest.slice(5).replace(/^ /, ""));
  if (data.length > 0) {
    const event = parseFrame(data.join("\n"));
    if (event) yield event;
  }
}

function parseFrame(text: string): OpencodeEvent | undefined {
  try {
    const value = JSON.parse(text) as unknown;
    if (typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string") return value as OpencodeEvent;
  } catch {
    // a malformed frame is dropped; the stream itself stays up
  }
  return undefined;
}
