// R16: secrets the agent needs (API keys, tokens, pairing codes) are asked through a masked
// card in Tide, never in chat. R19: kind "file" (the default) writes the value to a 0600 file and
// returns only the path, so the secret never enters the transcript. kind "value" returns it once
// in the tool result (the last line); the server redacts that exact string from the activity and
// from anything else the thread emits, which fails as soon as the agent re-encodes it.
import type { AgentBackend } from "./backend.ts";
import type { TextResult, ToolDef } from "./threadTools.ts";

const NAME = /^[A-Z0-9_]{1,64}$/;
const ok = (value: string): TextResult => ({ content: [{ type: "text", text: value }] });

export const SECRET_TOOL_DEFINITIONS: ToolDef[] = [
  {
    name: "tide_request_secret",
    description:
      "Ask the user for an API key, token, password or pairing code through a private masked card. Never ask for secrets in chat. By default (kind 'file') the secret is written to a private 0600 file and only its path is returned: read it from there (e.g. export VAR=\"$(cat <path>)\"). Use kind 'value' only when nothing can read a file; the value is hidden from the thread's log only as long as you never rewrite or re-encode it (base64, URL-encoding, splitting, quoting it into another string). On decline, do not ask again in chat.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[A-Z0-9_]{1,64}$", description: "Env-style name of the secret, e.g. GITHUB_TOKEN." },
        purpose: { type: "string", description: "One sentence the user reads on the card: what it is for and where it will be used." },
        kind: {
          type: "string",
          enum: ["value", "file"],
          description:
            "file (default, preferred): the secret is written to a private 0600 file and only the path is returned. value: the secret itself is returned in the result; Tide can redact it from the log only verbatim, so use it only when a file cannot work.",
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
  // R19: the file form unless the caller asks for the value; a path cannot leak through a re-encoding
  const kind = args["kind"] === "value" ? "value" : "file";
  const result = await backend.secretRequest({ name, purpose, ...(kind === "file" ? { kind } : {}) });
  if (result.decided !== "provided") return ok(declinedText(name));
  if (result.path !== undefined) return ok(`The user provided ${name}. It is in the file ${result.path} (mode 0600); read it from there and do not print it.`);
  if (result.value === undefined) return ok(declinedText(name));
  return ok(
    `The user provided ${name}. Use it for this task only. Do not repeat it in your replies, print or echo it, or write it to tracked files; prefer passing it through an environment variable. Tide redacts it from the thread's record.\n${result.value}`,
  );
}
