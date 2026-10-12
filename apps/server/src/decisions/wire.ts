/**
 * The TypeSafe "System One" wire format, in one place. Ported from the Python reference
 * (places-finder `app/decisions/wire.py`), itself copied from the typesafe-sdk source.
 *
 *   POST {base}/v1/systemone    Authorization: Bearer <key>
 *   { state, model, questions: { name: { type, instructions, criteria } } }
 *   -> { model, usage: { input_tokens, output_tokens },
 *        answers: { name: { type: "noul", noul: p }
 *                       | { type: "choice", choice, confidence, probabilities }
 *                       | { type: "score", score, confidence, probabilities } } }
 */
export const SYSTEM_ONE_PATH = "/v1/systemone";
export const DEFAULT_BASE_URL = "https://api.typesafe.ai";
export const DEFAULT_MODEL = "jev-latest";

export type State = string | Record<string, unknown> | unknown[];

export type Question =
  | { type: "noul"; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> }
  | { type: "score"; instructions: string; criteria: string[] };
export type Questions = Record<string, Question>;

export interface Answer {
  type: "noul" | "choice" | "score";
  /** noul: P(yes); choice: the chosen label; score: expected 0-based level */
  value: number | string;
  confidence: number;
  probabilities: Record<string, number>;
}

export interface Usage {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  model: string | undefined;
}

export const noul = (instructions: string): Question => ({ type: "noul", instructions });
export const score = (instructions: string, levels: string[]): Question => ({ type: "score", instructions, criteria: levels });
export const choice = (instructions: string, options: Record<string, string | null>): Question => ({ type: "choice", instructions, criteria: options });

export function requestBody(state: State, questions: Questions, model: string): { state: State; model: string; questions: Questions } {
  return { state, model, questions };
}

export function authHeaders(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function probs(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (isRecord(raw)) for (const [k, v] of Object.entries(raw)) out[k] = Number(v);
  return out;
}

function parseAnswer(raw: Record<string, unknown>): Answer | undefined {
  switch (raw["type"]) {
    case "noul": {
      const p = Number(raw["noul"]);
      if (!Number.isFinite(p)) throw new Error("noul is not a number");
      return { type: "noul", value: p, confidence: Math.max(p, 1 - p), probabilities: { true: p, false: 1 - p } };
    }
    case "choice":
      if (typeof raw["choice"] !== "string") throw new Error("choice is not a string");
      return { type: "choice", value: raw["choice"], confidence: Number(raw["confidence"] ?? 0), probabilities: probs(raw["probabilities"]) };
    case "score": {
      const s = Number(raw["score"]);
      if (!Number.isFinite(s)) throw new Error("score is not a number");
      return { type: "score", value: s, confidence: Number(raw["confidence"] ?? 0), probabilities: probs(raw["probabilities"]) };
    }
    default:
      return undefined;
  }
}

/** Throws `Error` when the body has no `answers` object or an answer is malformed. */
export function parseResponse(data: unknown): { answers: Record<string, Answer>; usage: Usage } {
  if (!isRecord(data) || !isRecord(data["answers"])) throw new Error("response has no 'answers' object");
  const answers: Record<string, Answer> = {};
  for (const [name, raw] of Object.entries(data["answers"])) {
    if (!isRecord(raw)) continue;
    try {
      const parsed = parseAnswer(raw);
      if (parsed) answers[name] = parsed;
    } catch (err) {
      throw new Error(`malformed answer ${JSON.stringify(name)}: ${(err as Error).message}`);
    }
  }
  const usage = isRecord(data["usage"]) ? data["usage"] : {};
  const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : undefined);
  return {
    answers,
    usage: { inputTokens: int(usage["input_tokens"]), outputTokens: int(usage["output_tokens"]), model: typeof data["model"] === "string" ? data["model"] : undefined },
  };
}
