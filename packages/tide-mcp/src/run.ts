import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TideAgentBackend, type McpEnv } from "./backend.ts";
import { createTideMcpServer } from "./server.ts";
import { trustedWebSocket } from "./tlsSocket.ts";

/**
 * Boots the Tide MCP server on stdio. Called both by `bin.ts` (dev, node with type
 * stripping) and by the server binary's `--mcp` mode (sidecar), so the two paths share
 * exactly one implementation.
 */
export async function runMcpServer(env: McpEnv = process.env): Promise<void> {
  const url = env.TIDE_SERVER_URL;
  const token = env.TIDE_AGENT_TOKEN;
  if (url === undefined || token === undefined) {
    throw new Error("tide-mcp needs TIDE_SERVER_URL and TIDE_AGENT_TOKEN in its environment");
  }
  // R19: a server that listens with TLS passes its certificate so this child can trust it on loopback
  const ca = env.TIDE_SERVER_CA;
  const backend = new TideAgentBackend({ url, token, ...(ca !== undefined && ca !== "" ? { webSocketImpl: await trustedWebSocket(ca) } : {}) });
  const server = createTideMcpServer({ backend });
  await server.connect(new StdioServerTransport());
  const shutdown = (): void => {
    backend.close();
    void server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
