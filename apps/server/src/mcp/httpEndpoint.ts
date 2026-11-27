import type { IncomingMessage, ServerResponse } from "node:http";
import { createElevationVerifier, ELEVATION_HEADER, ELEVATION_REQUIRED } from "./elevation.ts";
import { json, readBody } from "../rpc/http.ts";
import { RpcException } from "../rpc/router.ts";
import type { createRemoteTools } from "./remoteTools.ts";

const PROTOCOL_VERSIONS: readonly string[] = ["2025-03-26", "2025-06-18", "2025-11-25"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createMcpEndpoint(tools: ReturnType<typeof createRemoteTools>, secret: string, version: string) {
  const verify = createElevationVerifier(secret);
  return async (req: IncomingMessage, res: ServerResponse) => {
    const error = (status: number, id: unknown, code: number, message: string) =>
      json(res, status, { jsonrpc: "2.0", id, error: { code, message } });
    const raw = await readBody(req, 1024 * 1024);
    if (raw === "too-large") return error(413, null, -32600, "Request exceeds 1 MiB");
    let rpc: unknown;
    try {
      rpc = JSON.parse(raw.toString("utf8"));
    } catch {
      return error(400, null, -32700, "Parse error");
    }
    if (!record(rpc) || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string" ||
        (rpc.id !== undefined && typeof rpc.id !== "string" && typeof rpc.id !== "number")) {
      return error(400, null, -32600, "Invalid request");
    }
    const { id, method, params } = rpc;
    if (id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    if (params !== undefined && !record(params)) return error(200, id, -32602, "Invalid params");
    const respond = (result: unknown) => json(res, 200, { jsonrpc: "2.0", id, result });

    switch (method) {
      case "initialize": {
        const requested = params?.protocolVersion;
        return respond({
          protocolVersion: typeof requested === "string" && PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: {} },
          serverInfo: { name: "Tide Code v2", version },
        });
      }
      case "tools/list":
        return respond({ tools: tools.definitions });
      case "tools/call": {
        if (typeof params?.name !== "string" || (params.arguments !== undefined && !record(params.arguments))) {
          return error(200, id, -32602, "Expected a tool name and optional arguments object");
        }
        let elevated = false;
        try {
          const result = await tools.call(params.name, params.arguments ?? {}, () => {
            if (elevated) return;
            const token = req.headers[ELEVATION_HEADER];
            if (typeof token !== "string" || !verify(token).ok) throw new RpcException("forbidden", ELEVATION_REQUIRED);
            elevated = true;
          });
          return respond({ content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Tool failed";
          return respond({ isError: true, content: [{ type: "text", text: message }] });
        }
      }
      default:
        return error(200, id, -32601, "Method not found");
    }
  };
}
