import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProviderInstance, ProviderKind } from "@tide/contracts";
import type { DriverRegistry } from "../provider/registry.ts";
import type { SettingsStore } from "../settings.ts";
import type { Ask, JudgeBackend, JudgeCall, JudgeUnit, JudgeVerdict } from "./judge.ts";

export const FALLBACK_TIMEOUT_MS = 25_000;
export const FALLBACK_SYSTEM = "You are a classifier. Answer with exactly one label from the list and nothing else.";
/** chars per state token when clipping the state for the fallback prompt */
const CLIP_CHARS_PER_TOKEN = 3;

/** The labels the fallback may answer, with their descriptions. Yes-no maps to yes/no; a score to its level indices. */
export function labelsOf(ask: Ask): Record<string, string> {
  switch (ask.kind) {
    case "label":
      return ask.labels;
    case "yes-no":
      return { yes: "yes", no: "no" };
    case "score":
      return Object.fromEntries(ask.levels.map((level, i) => [String(i), level]));
  }
}

export function fallbackPrompt(call: JudgeCall, unit: JudgeUnit): string {
  const labels = Object.entries(labelsOf(unit.ask)).map(([k, d]) => (d === k ? k : `${k} — ${d}`));
  const json = typeof call.state === "string" ? call.state : JSON.stringify(call.state);
  const max = call.stateTokens * CLIP_CHARS_PER_TOKEN;
  const state = json.length <= max ? json : `${json.slice(0, max - 1)}…`;
  return `${unit.ask.instructions}\nLabels: ${labels.join("; ")}\nState:\n${state}`;
}

/** The harness's answer as a verdict, or undefined when it matched no label. */
export function parseFallback(unit: JudgeUnit, text: string, label: string | undefined): Pick<JudgeVerdict, "label" | "score"> | undefined {
  const labels = Object.keys(labelsOf(unit.ask));
  const norm = (s: string): string => s.trim().replace(/^["'`*\s]+|["'`*.\s]+$/g, "").toLowerCase();
  const candidates = [label, text.split(/\r?\n/).find((line) => line.trim().length > 0)].filter((c): c is string => c !== undefined);
  for (const c of candidates) {
    const hit = labels.find((l) => l.toLowerCase() === norm(c));
    if (hit === undefined) continue;
    if (unit.ask.kind === "yes-no") return { label: hit === "yes" ? "true" : "false", score: hit === "yes" ? 1 : 0 };
    if (unit.ask.kind === "score") return { label: hit, score: Number(hit) / Math.max(1, unit.ask.levels.length - 1) };
    return { label: hit };
  }
  return undefined;
}

export interface FallbackJudgeOptions {
  registry: Pick<DriverRegistry, "get" | "has" | "status">;
  settings: Pick<SettingsStore, "get">;
  /** `<dataDir>/judge` is the scratch cwd handed to the harness */
  dataDir: string;
  timeoutMs?: number;
  now?: () => number;
}

/**
 * The fallback judge: a one-shot, tools-off completion on the harness the user picked in
 * settings. Asked only for gray-zone verdicts, one unit per prompt, one prompt at a time.
 */
export class FallbackJudge implements JudgeBackend {
  readonly name = "fallback" as const;
  #registry: FallbackJudgeOptions["registry"];
  #settings: FallbackJudgeOptions["settings"];
  #dataDir: string;
  #timeoutMs: number;
  #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: FallbackJudgeOptions) {
    this.#registry = options.registry;
    this.#settings = options.settings;
    this.#dataDir = options.dataDir;
    this.#timeoutMs = options.timeoutMs ?? FALLBACK_TIMEOUT_MS;
    this.#now = options.now ?? Date.now;
  }

  /** The configured fallback, when its driver is in this build. */
  pick(): { provider: ProviderKind; model?: string } | undefined {
    const fb = this.#settings.get().decisions.fallback;
    return fb !== undefined && this.#registry.has(fb.provider) ? fb : undefined;
  }

  available(): boolean {
    return this.pick() !== undefined;
  }

  ask(calls: JudgeCall[], options: { timeoutMs?: number } = {}): Promise<JudgeVerdict[]> {
    // concurrency 1 across every caller
    const run = this.#queue.then(() => this.#askAll(calls, options.timeoutMs ?? this.#timeoutMs));
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #askAll(calls: JudgeCall[], timeoutMs: number): Promise<JudgeVerdict[]> {
    const pick = this.pick();
    const units = calls.flatMap((c) => c.units);
    const failAll = (error: string): JudgeVerdict[] => units.map((u) => this.#failed(u.id, error, 0));
    if (pick === undefined) return failAll("no fallback configured");
    let instance: ProviderInstance;
    try {
      instance = await this.#registry.get(pick.provider);
      const status = await this.#registry.status(pick.provider);
      if (instance.complete === undefined || status.caps.oneShot !== true) return failAll(`${pick.provider} cannot answer one-shot prompts`);
    } catch (err) {
      return failAll((err as Error)?.message ?? String(err));
    }
    const cwd = join(this.#dataDir, "judge");
    try {
      if (this.#dataDir !== ":memory:") mkdirSync(cwd, { recursive: true });
    } catch {
      /* the driver reports a missing cwd itself */
    }
    const out: JudgeVerdict[] = [];
    for (const call of calls) {
      for (const unit of call.units) out.push(await this.#askOne(instance, pick, call, unit, cwd, timeoutMs));
    }
    return out;
  }

  async #askOne(instance: ProviderInstance, pick: { provider: ProviderKind; model?: string }, call: JudgeCall, unit: JudgeUnit, cwd: string, timeoutMs: number): Promise<JudgeVerdict> {
    const started = this.#now();
    const complete = instance.complete;
    if (complete === undefined) return this.#failed(unit.id, "no one-shot support", 0);
    try {
      const result = await complete.call(instance, {
        system: FALLBACK_SYSTEM,
        prompt: fallbackPrompt(call, unit),
        ...(pick.model !== undefined ? { model: pick.model } : {}),
        labels: Object.keys(labelsOf(unit.ask)),
        maxOutputTokens: 16,
        timeoutMs,
        signal: AbortSignal.timeout(timeoutMs),
        cwd,
      });
      const tokens = result.usage?.inputTokens ?? 0;
      const model = result.model ?? pick.model ?? pick.provider;
      const parsed = parseFallback(unit, result.text, result.label);
      if (parsed === undefined) return { ...this.#failed(unit.id, `unmatched answer: ${result.text.slice(0, 80)}`, result.elapsedMs), tokens, model };
      return { id: unit.id, ...parsed, confidence: 1, source: "fallback", tokens, elapsedMs: result.elapsedMs, model };
    } catch (err) {
      return this.#failed(unit.id, (err as Error)?.message ?? String(err), this.#now() - started);
    }
  }

  #failed(id: string, error: string, elapsedMs: number): JudgeVerdict {
    return { id, confidence: 0, source: "fallback", tokens: 0, elapsedMs, error };
  }
}
