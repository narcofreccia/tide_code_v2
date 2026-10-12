import type { McpServerElicitationRequestParams } from "./generated/v2/McpServerElicitationRequestParams.ts";

/** One question of a Tide `UserInputActivity` (contracts `UserInputQuestion`). */
export interface FormQuestion {
  id: string;
  text: string;
  options?: { label: string; description?: string }[];
  multi?: boolean;
}

export interface ElicitationForm {
  questions: FormQuestion[];
  /** Tide answers (keyed by question id) -> MCP `content`; `undefined` when nothing was answered. */
  toContent: (answers: Record<string, unknown>) => Record<string, unknown> | undefined;
}

interface Field {
  question: FormQuestion;
  /** option label -> submitted value (titled enums show the title but submit the const) */
  values: Map<string, string>;
  kind: "string" | "number" | "boolean" | "multi";
}

type Schema = Record<string, unknown>;
const isObject = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** `enum` / `enumNames` / `oneOf` / `anyOf` const-options of a schema fragment, as label -> value. */
function enumOptions(schema: Schema): Map<string, string> | undefined {
  const titled = (Array.isArray(schema["oneOf"]) ? schema["oneOf"] : Array.isArray(schema["anyOf"]) ? schema["anyOf"] : undefined)?.filter(isObject);
  if (titled && titled.length > 0) {
    const out = new Map<string, string>();
    for (const option of titled) {
      const value = str(option["const"]);
      if (value !== undefined) out.set(str(option["title"]) ?? value, value);
    }
    return out.size > 0 ? out : undefined;
  }
  if (Array.isArray(schema["enum"])) {
    const names = Array.isArray(schema["enumNames"]) ? schema["enumNames"] : [];
    const out = new Map<string, string>();
    schema["enum"].forEach((value, index) => {
      if (typeof value === "string") out.set(typeof names[index] === "string" && names[index] !== "" ? (names[index] as string) : value, value);
    });
    return out.size > 0 ? out : undefined;
  }
  return undefined;
}

function field(name: string, raw: unknown, required: boolean): Field | undefined {
  if (!isObject(raw)) return undefined;
  const title = str(raw["title"]) ?? name;
  const description = str(raw["description"]);
  const text = `${title}${required ? " (required)" : ""}${description ? ` - ${description}` : ""}`;
  const type = raw["type"];
  if (type === "boolean") {
    return { kind: "boolean", values: new Map([["Yes", "true"], ["No", "false"]]), question: { id: name, text, options: [{ label: "Yes" }, { label: "No" }] } };
  }
  if (type === "array" && isObject(raw["items"])) {
    const values = enumOptions(raw["items"]);
    if (!values) return undefined;
    return { kind: "multi", values, question: { id: name, text, multi: true, options: [...values.keys()].map((label) => ({ label })) } };
  }
  if (type === "string") {
    const values = enumOptions(raw);
    if (values) return { kind: "string", values, question: { id: name, text, options: [...values.keys()].map((label) => ({ label })) } };
    return { kind: "string", values: new Map(), question: { id: name, text } };
  }
  if (type === "number" || type === "integer") return { kind: "number", values: new Map(), question: { id: name, text } };
  return undefined;
}

/**
 * Builds a Tide form from an MCP elicitation's requested schema, using only the top-level
 * string / number / boolean / enum / multi-select properties (nested objects are not
 * renderable as a question). `undefined` when nothing is renderable or the request is a URL flow —
 * the caller then falls back to a plain approval card.
 */
export function elicitationForm(params: Record<string, unknown>): ElicitationForm | undefined {
  const typed = params as unknown as McpServerElicitationRequestParams;
  if (typed.mode === "url") return undefined;
  const schema: unknown = (params as { requestedSchema?: unknown }).requestedSchema;
  if (!isObject(schema) || !isObject(schema["properties"])) return undefined;
  const required = new Set(Array.isArray(schema["required"]) ? schema["required"].filter((item): item is string => typeof item === "string") : []);
  const fields: Field[] = [];
  for (const [name, raw] of Object.entries(schema["properties"])) {
    const built = field(name, raw, required.has(name));
    if (built) fields.push(built);
  }
  if (fields.length === 0) return undefined;

  const server = str(params["serverName"]) ?? "MCP server";
  const message = str(params["message"]);
  const head = fields[0]!.question;
  head.text = `[${server}] ${message ? `${message}\n` : ""}${head.text}`;

  return {
    questions: fields.map((entry) => entry.question),
    toContent: (answers) => {
      const content: Record<string, unknown> = {};
      for (const entry of fields) {
        const raw = answers[entry.question.id];
        const given = typeof raw === "string" ? [raw] : Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
        if (given.length === 0 || given[0] === "") continue;
        const mapped = given.map((label) => entry.values.get(label) ?? label);
        if (entry.kind === "boolean") content[entry.question.id] = mapped[0] === "true";
        else if (entry.kind === "multi") content[entry.question.id] = mapped;
        else if (entry.kind === "number") {
          const number = Number(mapped[0]);
          if (Number.isFinite(number)) content[entry.question.id] = number;
        } else content[entry.question.id] = mapped[0];
      }
      return Object.keys(content).length > 0 ? content : undefined;
    },
  };
}
