import type { Static, TSchema } from "typebox";
import { Check, Errors } from "typebox/value";
import type { ProviderInstance } from "@tide/contracts";
import { RpcException } from "../rpc/router.ts";

export interface CompleteJsonOptions<S extends TSchema> {
  schema: S;
  system: string;
  prompt: string;
  model?: string;
  /** scratch dir for the harness; never a user worktree */
  cwd: string;
  maxOutputTokens?: number;
  timeoutMs?: number;
}

/** First balanced `{…}` in a model answer (fences and prose around it ignored; braces inside strings skipped). */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return undefined;
}

function validate<S extends TSchema>(schema: S, text: string): { value?: Static<S>; problem?: string } {
  const raw = extractJsonObject(text.replace(/```(?:json)?/g, ""));
  if (raw === undefined) return { problem: "the answer contained no JSON object" };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (err) {
    return { problem: `the JSON did not parse: ${(err as Error).message}` };
  }
  if (!Check(schema, value)) {
    const errors = Errors(schema, value)
      .slice(0, 8)
      .map((e) => `${e.instancePath || "/"} ${e.message}`);
    return { problem: `the JSON does not match the schema:\n${errors.join("\n")}` };
  }
  return { value: value as Static<S> };
}

/**
 * One-shot prompt whose answer must be a JSON object matching `schema`. Retries once with the
 * validation errors appended, then fails with `conflict`.
 */
export async function completeJson<S extends TSchema>(instance: Pick<ProviderInstance, "kind" | "complete">, opts: CompleteJsonOptions<S>): Promise<Static<S>> {
  if (instance.complete === undefined) throw new RpcException("conflict", `${instance.kind} cannot answer one-shot prompts`);
  const timeoutMs = opts.timeoutMs ?? 40_000;
  let prompt = opts.prompt;
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await instance.complete({
      system: opts.system,
      prompt,
      ...(opts.model !== undefined ? { model: opts.model } : {}),
      ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
      cwd: opts.cwd,
    });
    const checked = validate(opts.schema, result.text);
    if (checked.problem === undefined) return checked.value as Static<S>;
    problem = checked.problem;
    prompt = `${opts.prompt}\n\nYour previous answer was rejected because ${problem}\nReturn only the corrected JSON object.`;
  }
  throw new RpcException("conflict", `${instance.kind} did not return valid JSON: ${problem}`);
}
