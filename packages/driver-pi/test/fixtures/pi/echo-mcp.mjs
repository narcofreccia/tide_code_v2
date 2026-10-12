// Minimal stdio MCP server for the recordings: one `echo` tool. Newline-delimited JSON-RPC 2.0.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
createInterface({ input: process.stdin }).on("line", (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (request.id === undefined) return; // notification
  switch (request.method) {
    case "initialize":
      send({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: request.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1.0.0" } } });
      return;
    case "tools/list":
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { tools: [{ name: "echo", description: "Echo the text back", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, annotations: { readOnlyHint: true } }] },
      });
      return;
    case "tools/call":
      send({ jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: `echo: ${request.params?.arguments?.text ?? ""}` }] } });
      return;
    default:
      send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `unknown method ${request.method}` } });
  }
});
