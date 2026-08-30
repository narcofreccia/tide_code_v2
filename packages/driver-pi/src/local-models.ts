import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ModelInfo } from "@tide/contracts";
import type { FetchLike } from "./types.ts";

/**
 * Local-model discovery, ported from Tide v1 (`detect_ollama` / `detect_openai_models` in
 * `apps/desktop/src-tauri/src/lib.rs`). pi itself has no notion of "a server is running on
 * :11434"; it only reads `~/.pi/agent/models.json` (docs/models.md), so Tide probes the two
 * usual local servers and offers what it finds.
 *
 * Probing is read-only. `ensureLocalProvider()` — the only writer — runs when the user picks
 * a local model, never on `status()`, so Tide never edits the user's config unasked.
 */

export const OLLAMA_TAGS_URL = "http://localhost:11434/api/tags";
export const OLLAMA_BASE_URL = "http://localhost:11434/v1";
export const LMSTUDIO_MODELS_URL = "http://localhost:1234/v1/models";
export const LMSTUDIO_BASE_URL = "http://localhost:1234/v1";

const PROBE_TIMEOUT_MS = 1_500;

export type LocalFamily = "ollama" | "lmstudio";

export function modelsJsonPath(home = homedir()): string {
  return join(home, ".pi", "agent", "models.json");
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) return undefined;
    return await response.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function names(value: unknown, key: string): string[] {
  if (typeof value !== "object" || value === null) return [];
  const list = (value as Record<string, unknown>)[key];
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const id = (entry as Record<string, unknown>)["name"] ?? (entry as Record<string, unknown>)["id"];
    return typeof id === "string" && id !== "" ? [id] : [];
  });
}

/** `GET /api/tags` → `{ models: [{ name }] }`. */
export async function detectOllama(fetchImpl: FetchLike): Promise<string[]> {
  return names(await getJson(fetchImpl, OLLAMA_TAGS_URL), "models");
}

/** LM Studio speaks OpenAI: `GET /v1/models` → `{ data: [{ id }] }`. */
export async function detectLmStudio(fetchImpl: FetchLike): Promise<string[]> {
  return names(await getJson(fetchImpl, LMSTUDIO_MODELS_URL), "data");
}

export async function detectLocalModels(fetchImpl: FetchLike): Promise<ModelInfo[]> {
  const [ollama, lmstudio] = await Promise.all([detectOllama(fetchImpl), detectLmStudio(fetchImpl)]);
  return [
    ...ollama.map((id) => ({ id: `ollama/${id}`, label: `${id} (Ollama)`, family: "ollama" })),
    ...lmstudio.map((id) => ({ id: `lmstudio/${id}`, label: `${id} (LM Studio)`, family: "lmstudio" })),
  ];
}

interface ModelsJson {
  providers?: Record<string, { baseUrl?: string; api?: string; apiKey?: string; compat?: Record<string, boolean>; models?: { id: string }[] }>;
}

export function readModelsJson(path = modelsJsonPath()): ModelsJson | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null ? (parsed as ModelsJson) : undefined;
  } catch {
    return undefined;
  }
}

/** Splits `ollama/qwen2.5-coder:7b` into provider + model id. Returns undefined for non-local ids. */
export function parseLocalModelId(modelId: string): { family: LocalFamily; id: string } | undefined {
  const index = modelId.indexOf("/");
  if (index === -1) return undefined;
  const family = modelId.slice(0, index);
  const id = modelId.slice(index + 1);
  if ((family !== "ollama" && family !== "lmstudio") || id === "") return undefined;
  return { family, id };
}

/**
 * Adds a local provider + model to `~/.pi/agent/models.json`, preserving everything already
 * there. The dummy `apiKey` is what docs/models.md prescribes for keyless local servers, and
 * `compat` off is what OpenAI-compatible local servers need (no `developer` role, no
 * `reasoning_effort`). Returns the path written, or undefined when the id is not a local one.
 */
export function ensureLocalProvider(modelId: string, path = modelsJsonPath()): string | undefined {
  const parsed = parseLocalModelId(modelId);
  if (!parsed) return undefined;
  const current = readModelsJson(path) ?? {};
  const providers = current.providers ?? {};
  const existing = providers[parsed.family];
  const models = existing?.models ?? [];
  if (!models.some((model) => model.id === parsed.id)) models.push({ id: parsed.id });
  providers[parsed.family] = {
    baseUrl: existing?.baseUrl ?? (parsed.family === "ollama" ? OLLAMA_BASE_URL : LMSTUDIO_BASE_URL),
    api: existing?.api ?? "openai-completions",
    apiKey: existing?.apiKey ?? parsed.family,
    compat: existing?.compat ?? { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...current, providers }, null, 2)}\n`, "utf8");
  return path;
}
