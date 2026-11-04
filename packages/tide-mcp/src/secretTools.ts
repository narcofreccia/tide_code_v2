// R16: secrets the agent needs (API keys, tokens, pairing codes) are asked through a masked
// card in Tide, never in chat. The value comes back once in the tool result and is never
// stored in an event; kind "file" gets a 0600 file path instead.
import type { AgentBackend } from "./backend.ts";
import type { TextResult, ToolDef } from "./threadTools.ts";

const NAME = /^[A-Z0-9_]{1,64}$/;
const ok = (value: string): TextResult => ({ content: [{ type: "text", text: value }] });

export const SECRET_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "tide_request_secret",
    description:
      "Ask the user for an API key, token, password or pairing code through a private masked card. Never ask for secrets in chat. Returns the value once (or a file path with kind 'file'); on decline, do not ask again in chat.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[A-Z0-9_]{1,64}$", description: "Env-style name of the secret, e.g. GITHUB_TOKEN." },
        purpose: { type: "string", description: "One sentence the user reads on the card: what it is for and where it will be used." },
        kind: {
          type: "string",
          enum: ["value", "file"],
          description: "value (default): the secret is returned in the result. file: it is written to a private 0600 file and only the path is returned — prefer it when a tool can read the secret from a file.",
        },
      },
      required: ["name", "purpose"],
    },
  },
];

export const isSecretTool = (name: string): boolean => name === "tide_request_secret";

export const declinedText = (name: string): string =>
  `The user declined to provide ${name}. Do not ask for it in chat; continue without it or explain what it would unlock.`;

/** Handles tide_request_secret; throws raw errors (the caller maps them). */
export async function callSecretTool(backend: AgentBackend, args: Record<string, unknown>): Promise<TextResult> {
  const name = args["name"];
  if (typeof name !== "string" || !NAME.test(name)) throw new Error("`name` is required: uppercase letters, digits and _ (e.g. GITHUB_TOKEN)");
  const purpose = args["purpose"];
  if (typeof purpose !== "string" || purpose.trim() === "") throw new Error("`purpose` is required");
  const kind = args["kind"] === "file" ? "file" : "value";
  const result = await backend.secretRequest({ name, purpose, ...(kind === "file" ? { kind } : {}) });
  if (result.decided !== "provided") return ok(declinedText(name));
  if (result.path !== undefined) return ok(`The user provided ${name}. It is in the file ${result.path} (mode 0600); read it from there and do not print it.`);
  if (result.value === undefined) return ok(declinedText(name));
  return ok(`The user provided ${name}. Use it for this task only; do not echo it or write it to tracked files.\n${result.value}`);
}
