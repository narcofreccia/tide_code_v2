import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderKind, RuntimeMode } from "@tide/contracts";
import type { AgentBackend } from "./backend.ts";
import { TOOL_DEFINITIONS } from "./tools.ts";

/** The SDK's own result shape, so handlers stay assignable without a cast. */
export type ToolResult = CallToolResult;

const text = (value: string): ToolResult => ({ content: [{ type: "text", text: value }] });
const failure = (value: string): ToolResult => ({ content: [{ type: "text", text: value }], isError: true });

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`\`${key}\` is required`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Session state the tools keep in memory: the board's session id (learned from
 * agent.context) and the last message the agent has already been shown.
 */
export class BoardState {
  #backend: AgentBackend;
  #sessionId: string | undefined;
  #lastMessageId: string | undefined;

  constructor(backend: AgentBackend) {
    this.#backend = backend;
  }

  async sessionId(): Promise<string> {
    if (this.#sessionId !== undefined) return this.#sessionId;
    const ctx = await this.#backend.context();
    if (!ctx.session) throw new Error("this thread is not part of an expert panel");
    this.#sessionId = ctx.session.id;
    return this.#sessionId;
  }

  /** Messages that arrived since the previous check; advances the cursor. */
  async unreadMessages(): Promise<{ from: string; text: string; createdAt: number }[]> {
    const ctx = await this.#backend.context(this.#lastMessageId);
    const last = ctx.messages.at(-1);
    if (last) this.#lastMessageId = last.id;
    return ctx.messages.map((m) => ({ from: m.from, text: m.text, createdAt: m.createdAt }));
  }
}

export interface TideMcpServerOptions {
  backend: AgentBackend;
  version?: string;
}

export async function callTool(
  backend: AgentBackend,
  board: BoardState,
  name: string,
  rawArgs: Record<string, unknown>,
): Promise<ToolResult> {
  switch (name) {
    case "tide_experts_post_finding": {
      const sessionId = await board.sessionId();
      // author is stamped by the server from the authenticated thread; this is a placeholder
      await backend.dispatch({ type: "experts.finding.post", sessionId, author: "self", text: requireString(rawArgs, "text") });
      return text("Finding posted to the panel board.");
    }
    case "tide_experts_read_findings": {
      const ctx = await backend.context();
      if (!ctx.session) return failure("this thread is not part of an expert panel");
      if (ctx.findings.length === 0) return text("No findings posted yet.");
      return text(ctx.findings.map((f) => `- [${f.author}] ${f.text}`).join("\n"));
    }
    case "tide_experts_send_message": {
      const sessionId = await board.sessionId();
      await backend.dispatch({
        type: "experts.message.send",
        sessionId,
        from: "self",
        to: requireString(rawArgs, "to"),
        text: requireString(rawArgs, "text"),
      });
      return text("Message sent.");
    }
    case "tide_experts_check_messages": {
      const messages = await board.unreadMessages();
      if (messages.length === 0) return text("No new messages.");
      return text(messages.map((m) => `- ${m.from}: ${m.text}`).join("\n"));
    }
    case "tide_experts_synthesize": {
      const sessionId = await board.sessionId();
      await backend.dispatch({ type: "experts.synthesis.set", sessionId, markdown: requireString(rawArgs, "markdown") });
      return text("Synthesis recorded. The user can now implement it in a new thread.");
    }
    case "tide_delegate": {
      const provider = requireString(rawArgs, "provider") as ProviderKind;
      const mode = optionalString(rawArgs, "mode") as RuntimeMode | undefined;
      const model = optionalString(rawArgs, "model");
      const title = optionalString(rawArgs, "title");
      const repo = optionalString(rawArgs, "repo");
      const result = await backend.dispatch({
        type: "thread.delegate",
        // rewritten server-side to the calling thread
        fromThreadId: "self",
        provider,
        prompt: requireString(rawArgs, "prompt"),
        ...(model !== undefined ? { model } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(title !== undefined ? { title } : {}),
        ...(repo !== undefined ? { repo } : {}),
        ...(rawArgs["useWorktree"] === true ? { useWorktree: true } : {}),
      });
      const created = result.events.find((r) => r.event.type === "thread.created");
      const threadId = created?.event.type === "thread.created" ? created.event.thread.id : undefined;
      if (threadId === undefined) return failure("delegation did not produce a thread");
      return text(
        `${JSON.stringify({ threadId })}\nThe task is running. Poll tide_delegate_status with this threadId until it reports settled, then read lastAssistantText.`,
      );
    }
    case "tide_delegate_status": {
      const status = await backend.threadStatus(requireString(rawArgs, "threadId"));
      return text(JSON.stringify(status, null, 2));
    }
    default:
      return failure(`unknown tool ${name}`);
  }
}

/** Builds the MCP server; the caller connects it to a transport (stdio in production). */
export function createTideMcpServer(options: TideMcpServerOptions): Server {
  const { backend } = options;
  const board = new BoardState(backend);
  const server = new Server(
    { name: "tide", version: options.version ?? "0.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFINITIONS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return await callTool(backend, board, request.params.name, args);
    } catch (err) {
      return failure(err instanceof Error ? err.message : String(err));
    }
  });

  return server;
}
