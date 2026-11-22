import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TurnUsage } from "@tide/contracts";

/**
 * Fallback turn-usage reader for ACP harnesses that do not emit `PromptResponse.usage`
 * over the wire (e.g. Antigravity 1.5, which writes per-step token counts to its local
 * `transcript.jsonl`).
 */
export interface TranscriptUsageReader {
  /** Records the highest step already present in a resumed session's transcript. */
  baseline(sessionId: string): Promise<void>;
  /** Sums token usage for steps written since the previous baseline/delta. */
  delta(sessionId: string): Promise<TurnUsage | undefined>;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/;

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function antigravityTranscriptPath(home: string, sessionId: string): string | undefined {
  if (!SAFE_SESSION_ID.test(sessionId) || sessionId === "." || sessionId === "..") return undefined;
  return join(home, ".gemini", "antigravity-cli", "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
}

interface ParsedStep {
  stepIndex: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function parseSteps(raw: string): ParsedStep[] {
  const steps: ParsedStep[] = [];
  for (const line of raw.split("\n")) {
    if (!line.includes('"PLANNER_RESPONSE"') || !line.includes('"input_tokens"')) continue;
    let obj: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj["type"] !== "PLANNER_RESPONSE") continue;
    const stepIndex = typeof obj["step_index"] === "number" && Number.isFinite(obj["step_index"]) ? obj["step_index"] : undefined;
    if (stepIndex === undefined) continue;
    steps.push({
      stepIndex,
      input: num(obj["input_tokens"]),
      output: num(obj["output_tokens"]),
      cacheRead: num(obj["cache_read_tokens"]),
      cacheWrite: num(obj["cache_write_tokens"]),
    });
  }
  return steps;
}

/**
 * Tracks per-turn token deltas from Antigravity's local `transcript.jsonl` when `agy acp`
 * does not return `PromptResponse.usage`. Safe no-op when the file does not exist.
 */
export class AntigravityTranscriptUsage implements TranscriptUsageReader {
  #home: string;
  #lastStep = new Map<string, number>();

  constructor(home: string) {
    this.#home = home;
  }

  async baseline(sessionId: string): Promise<void> {
    const steps = await this.#read(sessionId);
    if (!steps || steps.length === 0) return;
    let max = this.#lastStep.get(sessionId) ?? -1;
    for (const s of steps) if (s.stepIndex > max) max = s.stepIndex;
    this.#lastStep.set(sessionId, max);
  }

  async delta(sessionId: string): Promise<TurnUsage | undefined> {
    const steps = await this.#read(sessionId);
    if (!steps || steps.length === 0) return undefined;
    const prev = this.#lastStep.get(sessionId) ?? -1;
    let max = prev;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    const seen = new Set<number>();
    for (const s of steps) {
      if (s.stepIndex <= prev || seen.has(s.stepIndex)) continue;
      seen.add(s.stepIndex);
      if (s.stepIndex > max) max = s.stepIndex;
      inputTokens += s.input;
      outputTokens += s.output;
      cacheReadTokens += s.cacheRead;
      cacheWriteTokens += s.cacheWrite;
    }
    this.#lastStep.set(sessionId, max);
    if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) return undefined;
    return {
      inputTokens,
      outputTokens,
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    };
  }

  async #read(sessionId: string): Promise<ParsedStep[] | undefined> {
    const path = antigravityTranscriptPath(this.#home, sessionId);
    if (!path) return undefined;
    try {
      const raw = await readFile(path, "utf8");
      return parseSteps(raw);
    } catch {
      return undefined;
    }
  }
}
