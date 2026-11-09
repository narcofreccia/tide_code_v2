import type { Message, ProviderKind, ReadModel } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import type { SettingsStore } from "../settings.ts";
import { completeOneShot, pickProvider, type OneShotDeps } from "./oneShot.ts";
import { RpcException } from "./router.ts";

export { pickProvider };

export const TITLE_SYSTEM = "You write short titles for coding conversations. Answer with the title only.";
export const TITLE_MAX_CHARS = 60;
export const TITLE_TIMEOUT_MS = 25_000;
const CLIP = 600;

export interface TitleDeps extends OneShotDeps {
  engine: Pick<Engine, "getModel" | "dispatch">;
}

const clip = (text: string): string => (text.length <= CLIP ? text : `${text.slice(0, CLIP - 1)}…`);

/** First user prompt and latest assistant reply of a thread, each clipped to 600 chars. */
export function titlePrompt(model: ReadModel, threadId: string, instructions?: string): string {
  const messages: Message[] = Object.values(model.messages)
    .filter((m) => m.threadId === threadId && m.notification === undefined)
    .sort((a, b) => a.createdAt - b.createdAt);
  const first = messages.find((m) => m.role === "user" && m.text.trim() !== "");
  const last = [...messages].reverse().find((m) => m.role === "assistant" && m.text.trim() !== "");
  const parts = [`Write a title of at most ${TITLE_MAX_CHARS} characters for this conversation. Imperative mood, no quotes, no trailing period.`];
  if (first) parts.push(`First request:\n${clip(first.text.trim())}`);
  if (last) parts.push(`Latest reply:\n${clip(last.text.trim())}`);
  const extra = instructions?.trim();
  if (extra) parts.push(`Extra instructions from the user:\n${extra}`);
  return parts.join("\n\n");
}

/** A project's own instructions win over the global ones; a blank project value counts as unset. */
export function titleInstructionsFor(model: ReadModel, threadId: string, settings: Pick<SettingsStore, "get">): string | undefined {
  const projectId = model.threads[threadId]?.projectId;
  const own = projectId === undefined ? undefined : model.projects[projectId]?.titleInstructions?.trim();
  return own || settings.get().titleInstructions?.trim() || undefined;
}

/** Model output to a single clean title: first line, quotes and trailing period removed, ≤ 60 chars. */
export function cleanTitle(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim() !== "") ?? "";
  let t = line.trim().replace(/^(title\s*:\s*)/i, "").replace(/^["'`*“‘\s]+|["'`*”’\s]+$/g, "").replace(/[.\s]+$/, "");
  if (t.length > TITLE_MAX_CHARS) t = `${t.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}…`;
  return t;
}

export async function regenerateTitle(deps: TitleDeps, threadId: string): Promise<{ title: string; provider: ProviderKind; model?: string }> {
  const model = deps.engine.getModel();
  const thread = model.threads[threadId];
  if (!thread) throw new RpcException("not-found", `unknown thread ${threadId}`);
  // the SDK counts the whole reply incl. preamble; 64 was hit live on haiku, like the R6 fallback
  const result = await completeOneShot(deps, {
    system: TITLE_SYSTEM,
    prompt: titlePrompt(model, threadId, titleInstructionsFor(model, threadId, deps.settings)),
    maxOutputTokens: 256,
    timeoutMs: TITLE_TIMEOUT_MS,
    scratch: "titles",
  });
  const title = cleanTitle(result.text);
  if (title === "") throw new RpcException("internal", `${result.provider} returned no title`);
  try {
    await deps.engine.dispatch({ type: "thread.update", threadId, title });
  } catch (err) {
    throw new RpcException("internal", (err as Error)?.message ?? String(err));
  }
  return { title, provider: result.provider, ...(result.model !== undefined ? { model: result.model } : {}) };
}
