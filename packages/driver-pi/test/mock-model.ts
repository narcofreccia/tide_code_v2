import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A scripted OpenAI-compatible chat-completions endpoint for driving a REAL `pi --mode rpc`
 * without model credentials. pi's side of every exchange — its RPC frames, extension UI, tool
 * execution, session bookkeeping — is genuine pi 1.1.0 behaviour; only the model's replies are
 * scripted. Each request consumes the next reply; when the script runs out the model says "done".
 */

export interface MockToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface MockReply {
  text?: string;
  reasoning?: string;
  toolCalls?: MockToolCall[];
  /** answer with this HTTP status and an error body instead of a stream */
  status?: number;
  error?: string;
}

export interface MockModel {
  baseUrl: string;
  /** every request body pi sent, oldest first */
  requests: Record<string, unknown>[];
  /** queue more replies (consumed after the ones already queued) */
  push(...replies: MockReply[]): void;
  close(): Promise<void>;
}

function chunk(res: ServerResponse, delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, number>): void {
  const body = { id: "chatcmpl-mock", object: "chat.completion.chunk", created: 0, model: "mock-1", choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) };
  res.write(`data: ${JSON.stringify(body)}\n\n`);
}

function stream(res: ServerResponse, reply: MockReply, seq: number): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  chunk(res, { role: "assistant", content: "" });
  if (reply.reasoning) chunk(res, { reasoning_content: reply.reasoning });
  if (reply.text) {
    // two pieces so a delta stream is observable
    const half = Math.ceil(reply.text.length / 2);
    chunk(res, { content: reply.text.slice(0, half) });
    if (reply.text.length > half) chunk(res, { content: reply.text.slice(half) });
  }
  (reply.toolCalls ?? []).forEach((call, index) => {
    chunk(res, { tool_calls: [{ index, id: `call_${seq}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] });
  });
  const finish = reply.toolCalls && reply.toolCalls.length > 0 ? "tool_calls" : "stop";
  chunk(res, {}, finish, { prompt_tokens: 100 * seq, completion_tokens: 10 * seq, total_tokens: 110 * seq });
  res.write("data: [DONE]\n\n");
  res.end();
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function startMockModel(replies: MockReply[] = []): Promise<MockModel> {
  const queue = [...replies];
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      requests.push(await body(req));
      const reply = queue.shift() ?? { text: "done" };
      if (reply.status !== undefined) {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: reply.error ?? "mock failure", type: "invalid_request_error" } }));
        return;
      }
      stream(res, reply, requests.length);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    push: (...more) => queue.push(...more),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/**
 * A throwaway pi agent dir (`PI_CODING_AGENT_DIR`) whose only provider is the mock. The key is
 * a placeholder the mock ignores; nothing here is a credential.
 */
export function mockAgentDir(baseUrl: string): string {
  const dir = mkdtempSync(join(tmpdir(), "tide-pi-agent-"));
  const models = {
    providers: {
      mock: { baseUrl, api: "openai-completions", apiKey: "mock-placeholder", models: [
        { id: "mock-1", name: "Mock 1", contextWindow: 32_000, maxTokens: 4_096 },
        { id: "mock-2", name: "Mock 2", contextWindow: 64_000, maxTokens: 4_096 },
      ] },
    },
  };
  writeFileSync(join(dir, "models.json"), JSON.stringify(models, null, 2));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ defaultProvider: "mock", defaultModel: "mock-1", retry: { enabled: false } }, null, 2));
  return dir;
}
