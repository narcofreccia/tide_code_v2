import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, ProviderKind, ReadModel } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { DriverRegistry } from "../provider/registry.ts";
import type { SettingsStore } from "../settings.ts";
import { RpcException } from "./router.ts";

export const TITLE_SYSTEM = "You write short titles for coding conversations. Answer with the title only.";
export const TITLE_MAX_CHARS = 60;
export const TITLE_TIMEOUT_MS = 25_000;
const CLIP = 600;

export interface TitleDeps {
  engine: Pick<Engine, "getModel" | "dispatch">;
  registry: Pick<DriverRegistry, "get" | "has" | "statusAll" | "status">;
  settings: Pick<SettingsStore, "get">;
  /** scratch cwd parent for the harness; the OS temp dir when absent */
  tideHome?: string;
}

const clip = (text: string): string => (text.length <= CLIP ? text : `${text.slice(0, CLIP - 1)}…`);

/** First user prompt and latest assistant reply of a thread, each clipped to 600 chars. */
export function titlePrompt(model: ReadModel, threadId: string): string {
  const messages: Message[] = Object.values(model.messages)
    .filter((m) => m.threadId === threadId && m.notification === undefined)
    .sort((a, b) => a.createdAt - b.createdAt);
  const first = messages.find((m) => m.role === "user" && m.text.trim() !== "");
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.text.trim() !== "");
  const parts = [`Write a title of at most ${TITLE_MAX_CHARS} characters for this conversation. Imperative mood, no quotes, no trailing period.`];
  if (first) parts.push(`First request:\n${clip(first.text.trim())}`);
  if (last) parts.push(`Latest reply:\n${clip(last.text.trim())}`);
  return parts.join("\n\n");
}

/** Model output to a single clean title: first line, quotes and trailing period removed, ≤ 60 chars. */
export function cleanTitle(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  let t = line.trim().replace(/^(title\s*:\s*)/i, "").replace(/^["'`*“‘\s]+|["'`*”’\s]+$/g, "").replace(/[.\s]+$/, "");
  if (t.length > TITLE_MAX_CHARS) t = `${t.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
  return t;
}

async function pickProvider(deps: TitleDeps): Promise<{ provider: ProviderKind; model?: string }> {
  const chosen = deps.settings.get().textModel;
  if (chosen !== undefined && deps.registry.has(chosen.provider)) {
    return { provider: chosen.provider, ...(chosen.model !== undefined ? { model: chosen.model } : {}) };
  }
  for (const status of await deps.registry.statusAll()) {
    if (status.caps.oneShot === true) return { provider: status.kind };
  }
  throw new RpcException("conflict", "no installed harness can answer one-shot prompts; pick one in settings");
}

export async function regenerateTitle(deps: TitleDeps, threadId: string): Promise<{ title: string; provider: ProviderKind; model?: string }> {
  const model = deps.engine.getModel();
  const thread = model.threads[threadId];
  if (!thread) throw new RpcException("not-found", `unknown thread ${threadId}`);
  const pick = await pickProvider(deps);
  let result;
  try {
    const instance = await deps.registry.get(pick.provider);
    if (instance.complete === undefined) throw new RpcException("conflict", `${pick.provider} cannot answer one-shot prompts`);
    const cwd = join(deps.tideHome ?? tmpdir(), "titles");
    try {
      mkdirSync(cwd, { recursive: true });
    } catch {
      /* the driver reports a missing cwd itself */
    }
    result = await instance.complete({
      system: TITLE_SYSTEM,
      prompt: titlePrompt(model, threadId),
      ...(pick.model !== undefined ? { model: pick.model } : {}),
      // the SDK counts the whole reply incl. preamble; 64 was hit live on haiku, like the R6 fallback
      maxOutputTokens: 256,
      timeoutMs: TITLE_TIMEOUT_MS,
      signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
      cwd,
    });
  } catch (err) {
    if (err instanceof RpcException) throw err;
    throw new RpcException("internal", (err as Error)?.message ?? String(err));
  }
  const title = cleanTitle(result.text);
  if (title === "") throw new RpcException("internal", `${pick.provider} returned no title`);
  try {
    await deps.engine.dispatch({ type: "thread.update", threadId, title });
  } catch (err) {
    throw new RpcException("internal", (err as Error)?.message ?? String(err));
  }
  const used = result.model ?? pick.model;
  return { title, provider: pick.provider, ...(used !== undefined ? { model: used } : {}) };
}
