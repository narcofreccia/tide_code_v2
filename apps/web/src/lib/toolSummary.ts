/** One readable line for a finished tool call, plus the raw output pretty-printed when it was JSON. */
export interface ToolSummary {
  line: string;
  /** the output re-indented (`JSON.stringify(_, null, 2)`) when it parsed as JSON */
  detail?: string;
}

const LINE_MAX = 160;
const MESSAGE_MAX = 100;
const JSON_TEXT_KEYS = ["message", "summary", "error"];
const PATH_KEYS = ["file_path", "filePath", "path", "notebook_path", "file"];
const RECIPIENT_KEYS = ["to", "recipient", "agent_id", "agentId", "target"];
const BODY_KEYS = ["message", "content", "text", "prompt"];

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function pick(value: unknown, keys: string[]): string | undefined {
  const rec = record(value);
  if (rec === undefined) return undefined;
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.trim() !== "") return v;
  }
  return undefined;
}

/** The output as a JSON value when the whole text is an object or array. */
function parseJson(output: string): unknown {
  const text = output.trim();
  if (!(text.startsWith("{") || text.startsWith("["))) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * `summarizeToolResult("SendMessage", {to, message}, '{"success":true,…}')` →
 * `{ line: "to a1d3: Resume the survey…", detail: "{\n  \"success\": true …" }`.
 * Order: a JSON output's own message/summary/error, then per-tool input (SendMessage
 * recipient, Bash command, Read/Edit/Write path), then the first non-empty output line.
 */
export function summarizeToolResult(toolName: string, input: unknown, output: string | undefined): ToolSummary {
  const json = output === undefined ? undefined : parseJson(output);
  const detail = json === undefined ? undefined : JSON.stringify(json, null, 2);
  const withDetail = (line: string): ToolSummary => (detail === undefined ? { line } : { line, detail });

  const said = pick(json, JSON_TEXT_KEYS);
  if (said !== undefined) return withDetail(clip(said, LINE_MAX));

  const name = toolName.toLowerCase();
  if (name === "sendmessage") {
    const to = pick(input, RECIPIENT_KEYS);
    const body = pick(input, BODY_KEYS);
    if (to !== undefined || body !== undefined) {
      return withDetail(`to ${to ?? "?"}${body !== undefined ? `: ${clip(body, MESSAGE_MAX)}` : ""}`);
    }
  }
  if (/^(bash|shell|exec)$/.test(name)) {
    const command = pick(input, ["command", "cmd", "script"]);
    if (command !== undefined) return withDetail(clip(command.split("\n")[0] ?? command, LINE_MAX));
  }
  if (/^(read|edit|write|multiedit|notebookedit)$/.test(name)) {
    const path = pick(input, PATH_KEYS);
    if (path !== undefined) return withDetail(path);
  }
  const first = (output ?? "").split("\n").find((l) => l.trim() !== "");
  return withDetail(first === undefined ? "" : clip(first, LINE_MAX));
}
