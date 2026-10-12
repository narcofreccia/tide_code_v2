import type { SettingsStore } from "../settings.ts";
import { authHeaders, DEFAULT_BASE_URL, DEFAULT_MODEL, parseResponse, requestBody, SYSTEM_ONE_PATH, type Answer, type Questions, type State } from "./wire.ts";

/**
 * Client for TypeSafe's decisions API (System One, model Jev). Tide uses it only to sort the
 * Inbox: it never gates, routes or acts. Ported from the Python reference; the client never
 * touches the event log. `ask` validates every question against the model limits, splits them
 * into requests that fit, sends each through the injectable `transport` with a timeout and
 * one retry on a transient failure, and returns `{ name: Answer }`.
 */
export const DECISIONS_UNAVAILABLE = "decisions_unavailable";
export const DECISION_FAILED = "decision_failed";
export const DECISION_LIMIT = "decision_limit";

/** Conservative chars -> tokens (the API ships no tokenizer). */
export const CHARS_PER_TOKEN = 3.0;
export const DEFAULT_TIMEOUT_MS = 20_000;
export const RETRY_DELAY_MS = 500;
/** $ per 1M input tokens (jev-1.13.0). */
export const USD_PER_MILLION_INPUT_TOKENS = 0.042;

/** No key, or the feature is off: callers fall back silently. */
export class DecisionsUnavailable extends Error {
  readonly code = DECISIONS_UNAVAILABLE;
  constructor(message = "decisions are not enabled") {
    super(message);
  }
}
export class DecisionError extends Error {
  readonly code: string = DECISION_FAILED;
  readonly statusCode: number | undefined;
  constructor(message: string, statusCode?: number) {
    super(message);
    this.statusCode = statusCode;
  }
}
/** Worth one retry: 429, 5xx, connect error, timeout. */
export class TransientDecisionError extends DecisionError {}
/** A question or state that cannot fit even alone. */
export class DecisionLimitError extends Error {
  readonly code = DECISION_LIMIT;
}

export interface Limits {
  maxRequestTokens: number;
  maxStateQuestionTokens: number;
  maxChoiceOptions: number;
  maxScoreLevels: number;
  /** headroom under the limits for the estimate */
  safety: number;
}
export const DEFAULT_LIMITS: Limits = { maxRequestTokens: 64_000, maxStateQuestionTokens: 32_000, maxChoiceOptions: 255, maxScoreLevels: 10, safety: 0.9 };

export type Transport = (payload: object, timeoutMs: number) => Promise<unknown>;

export interface RequestRecord {
  questions: number;
  inputTokens: number;
  outputTokens: number;
  /** the response carried no usage; tokens are our estimate */
  estimated: boolean;
  model: string;
  costUsd: number;
}

export const costUsd = (inputTokens: number): number => (inputTokens * USD_PER_MILLION_INPUT_TOKENS) / 1_000_000;

export function estimateTokens(obj: unknown): number {
  const text = typeof obj === "string" ? obj : JSON.stringify(obj);
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function validateQuestion(name: string, q: Questions[string], limits: Limits): void {
  if (q.type === "choice") {
    const n = Object.keys(q.criteria).length;
    if (n < 1 || n > limits.maxChoiceOptions) throw new DecisionLimitError(`choice ${name}: 1..${limits.maxChoiceOptions} options required`);
  } else if (q.type === "score") {
    if (q.criteria.length < 2 || q.criteria.length > limits.maxScoreLevels) throw new DecisionLimitError(`score ${name}: 2..${limits.maxScoreLevels} levels required`);
  } else if (q.type !== "noul") {
    throw new DecisionLimitError(`question ${name}: unknown type`);
  }
}

export function requestFits(state: State, questions: Questions, limits: Limits): boolean {
  const entries = Object.entries(questions);
  if (entries.length === 0) return true;
  const stateT = estimateTokens(state);
  const qTokens = entries.map(([k, v]) => estimateTokens({ [k]: v }));
  return stateT + Math.max(...qTokens) <= limits.maxStateQuestionTokens * limits.safety && stateT + qTokens.reduce((a, b) => a + b, 0) <= limits.maxRequestTokens * limits.safety;
}

/** One state's questions in chunks that each fit a request; throws when state + one question cannot fit. */
export function splitQuestions(state: State, questions: Questions, limits: Limits): Questions[] {
  const stateT = estimateTokens(state);
  const chunks: Questions[] = [];
  let current: Questions = {};
  let currentT = stateT;
  for (const [name, q] of Object.entries(questions)) {
    const qt = estimateTokens({ [name]: q });
    if (stateT + qt > limits.maxStateQuestionTokens * limits.safety) {
      throw new DecisionLimitError(`state (~${stateT} tok) + question ${name} (~${qt} tok) exceeds ${limits.maxStateQuestionTokens} tokens`);
    }
    if (Object.keys(current).length > 0 && currentT + qt > limits.maxRequestTokens * limits.safety) {
      chunks.push(current);
      current = {};
      currentT = stateT;
    }
    current[name] = q;
    currentT += qt;
  }
  if (Object.keys(current).length > 0) chunks.push(current);
  return chunks;
}

/** Greedily groups items so each group's request fits; an item that does not fit alone still gets its own group. */
export function packBatches<T>(items: readonly T[], build: (items: readonly T[]) => { state: State; questions: Questions }, limits: Limits): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    const candidate = [...current, item];
    const req = build(candidate);
    if (current.length > 0 && !requestFits(req.state, req.questions, limits)) {
      batches.push(current);
      current = [item];
    } else current = candidate;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** POST {baseUrl}/v1/systemone with fetch; an injectable `fetchImpl` keeps tests offline. */
export function fetchTransport(apiKey: string, baseUrl: string, fetchImpl: typeof fetch = fetch): Transport {
  const url = baseUrl.replace(/\/+$/, "") + SYSTEM_ONE_PATH;
  return async (payload, timeoutMs) => {
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "POST", headers: authHeaders(apiKey), body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      throw new TransientDecisionError(`${(err as Error).name}: ${(err as Error).message}`);
    }
    if (res.status === 429 || res.status >= 500) throw new TransientDecisionError(`HTTP ${res.status}`, res.status);
    if (res.status >= 400) throw new DecisionError(`HTTP ${res.status}`, res.status);
    try {
      return await res.json();
    } catch {
      throw new DecisionError("response is not JSON");
    }
  };
}

export interface DecisionClientOptions {
  model?: string;
  transport: Transport;
  limits?: Limits;
  timeoutMs?: number;
  /** pause before the single retry; tests pass a no-op */
  sleep?: (ms: number) => Promise<void>;
  /** false = every `ask` rejects with DecisionsUnavailable (read live, so settings changes apply at once) */
  enabled?: () => boolean;
  /** called once per request that got an answer (cost logging) */
  onRequest?: (record: RequestRecord) => void;
}

export class DecisionClient {
  readonly model: string;
  readonly limits: Limits;
  #transport: Transport;
  #timeoutMs: number;
  #sleep: (ms: number) => Promise<void>;
  #enabled: () => boolean;
  #onRequest: ((record: RequestRecord) => void) | undefined;

  constructor(options: DecisionClientOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    this.#transport = options.transport;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#enabled = options.enabled ?? (() => true);
    this.#onRequest = options.onRequest;
  }

  get enabled(): boolean {
    return this.#enabled();
  }

  /** Answers every question about `state` (split into as many requests as needed, sequentially). */
  async ask(state: State, questions: Questions, timeoutMs?: number): Promise<Record<string, Answer>> {
    if (!this.#enabled()) throw new DecisionsUnavailable();
    if (Object.keys(questions).length === 0) return {};
    for (const [name, q] of Object.entries(questions)) validateQuestion(name, q, this.limits);
    const merged: Record<string, Answer> = {};
    for (const chunk of splitQuestions(state, questions, this.limits)) Object.assign(merged, await this.#send(state, chunk, timeoutMs ?? this.#timeoutMs));
    return merged;
  }

  async #send(state: State, questions: Questions, timeoutMs: number): Promise<Record<string, Answer>> {
    const payload = requestBody(state, questions, this.model);
    const estimated = estimateTokens(payload);
    const data = await this.#call(payload, timeoutMs);
    let parsed: ReturnType<typeof parseResponse>;
    try {
      parsed = parseResponse(data);
    } catch (err) {
      throw new DecisionError((err as Error).message);
    }
    const inputTokens = parsed.usage.inputTokens ?? estimated;
    this.#onRequest?.({
      questions: Object.keys(questions).length,
      inputTokens,
      outputTokens: parsed.usage.outputTokens ?? 0,
      estimated: parsed.usage.inputTokens === undefined,
      model: parsed.usage.model ?? this.model,
      costUsd: costUsd(inputTokens),
    });
    return parsed.answers;
  }

  /** The transport call with one retry on a transient error. */
  async #call(payload: object, timeoutMs: number): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#transport(payload, timeoutMs);
      } catch (err) {
        if (err instanceof TransientDecisionError) {
          if (attempt === 1) throw err;
        } else if (err instanceof DecisionError) throw err;
        else throw new DecisionError(`${(err as Error)?.name ?? "Error"}: ${(err as Error)?.message ?? String(err)}`);
      }
      await this.#sleep(RETRY_DELAY_MS);
    }
  }
}

export interface CreateDecisionClientOptions {
  settings: SettingsStore;
  env?: Record<string, string | undefined>;
  /** replaces the HTTP transport (tests, or a local stub) */
  transport?: Transport;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string, data?: unknown) => void;
}

/** Key from the settings store, else `TIDE_TYPESAFE_API_KEY`; enabled only with the flag on AND a key. */
export function createDecisionClient(options: CreateDecisionClientOptions): DecisionClient {
  const { settings } = options;
  const env = options.env ?? process.env;
  const key = (): string | undefined => {
    const k = settings.decisionsApiKey() ?? env["TIDE_TYPESAFE_API_KEY"];
    return k !== undefined && k.length > 0 ? k : undefined;
  };
  const baseUrl = env["TIDE_TYPESAFE_BASE_URL"] ?? DEFAULT_BASE_URL;
  const transport: Transport =
    options.transport ??
    ((payload, timeoutMs) => {
      const k = key();
      if (k === undefined) return Promise.reject(new DecisionsUnavailable("no TypeSafe key"));
      return fetchTransport(k, baseUrl, options.fetchImpl)(payload, timeoutMs);
    });
  const log = options.log ?? (() => undefined);
  return new DecisionClient({
    transport,
    enabled: () => settings.get().decisions.enabled && key() !== undefined,
    ...(options.sleep !== undefined ? { sleep: options.sleep } : {}),
    onRequest: (r) => log(`[decisions] ${r.model}: ${r.questions} questions, ${r.inputTokens}${r.estimated ? " (est.)" : ""} in / ${r.outputTokens} out tokens, $${r.costUsd.toFixed(6)}`),
  });
}
