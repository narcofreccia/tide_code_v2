import type { CompletionRequest, CompletionResult, TurnUsage } from "@tide/contracts";
import type { OpencodeApi } from "./types.ts";
import type { ModelRef, PermissionRule, WireMessage } from "./wire.ts";

/**
 * Session rules are evaluated after the agent's (`findLast` over `[...agent, ...session]`), so
 * one trailing wildcard deny overrides every tool and permission the agent or user config allows.
 */
export const DENY_ALL: PermissionRule[] = [{ action: "*", resource: "*", effect: "deny" }];

/** newest messages read back to find the answer; a tools-off call is one or two steps */
const MESSAGE_PAGE = 20;

export interface CompleteDeps {
  api: () => Promise<OpencodeApi>;
  /** `provider/model` → ref; an id that does not parse falls back to OpenCode's default model */
  parseModel: (id: string) => ModelRef | undefined;
  defaultModel?: string;
  instructionKey: string;
  log: (msg: string) => void;
}

/**
 * One-shot classifier call: a throwaway session with every permission denied, Tide's system
 * text as its instruction entry, one prompt, wait for idle, read the last assistant text. The
 * session is always removed so it never lingers in the user's TUI. OpenCode has no output
 * schema on prompts, so `label` stays unset and the caller parses the text.
 */
export async function complete(deps: CompleteDeps, request: CompletionRequest): Promise<CompletionResult> {
  const started = Date.now();
  const api = await deps.api();
  const id = request.model ?? deps.defaultModel;
  const model = id === undefined ? undefined : deps.parseModel(id);
  let sessionId: string | undefined;
  let settled = false;

  const work = (async (): Promise<CompletionResult> => {
    const created = await api.createSession({
      directory: request.cwd,
      title: "tide judge",
      ...(model ? { model } : {}),
      permissions: DENY_ALL,
      metadata: { tideOneShot: true },
    });
    sessionId = created.id;
    // aborted while the create was in flight: the race already settled, clean up here
    if (settled) {
      await cleanup(api, created.id, deps.log);
      throw new Error("completion abandoned");
    }
    await api.putInstruction({ sessionId: created.id, key: deps.instructionKey, value: request.system });
    await api.prompt({ sessionId: created.id, text: request.prompt });
    await api.waitIdle({ sessionId: created.id });
    const page = await api.messages({ sessionId: created.id, limit: MESSAGE_PAGE });
    return answerOf(page.data, started);
  })();

  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout: opencode completion exceeded ${request.timeoutMs}ms`)), request.timeoutMs);
    if (request.signal?.aborted) reject(new Error("aborted: opencode completion cancelled"));
    request.signal?.addEventListener("abort", () => reject(new Error("aborted: opencode completion cancelled")));
  });

  try {
    return await Promise.race([work, stop]);
  } catch (error) {
    // the losing branch may still reject later; it must not surface as unhandled
    work.catch(() => undefined);
    if (sessionId !== undefined) await api.interrupt({ sessionId }).catch(() => undefined);
    throw error;
  } finally {
    settled = true;
    if (timer !== undefined) clearTimeout(timer);
    if (sessionId !== undefined) await cleanup(api, sessionId, deps.log);
  }
}

async function cleanup(api: OpencodeApi, sessionId: string, log: (msg: string) => void): Promise<void> {
  await api.removeSession({ sessionId }).catch((error: unknown) => {
    log(`[opencode] could not remove one-shot session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
  });
}

/** `messages` is newest first: the first assistant message is the answer. */
export function answerOf(newestFirst: WireMessage[], started: number): CompletionResult {
  const reply = newestFirst.find((message) => message.type === "assistant");
  const idle = newestFirst.find((message) => message.type === "idle");
  const text = (reply?.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
  if (text === "") {
    const error = reply?.error ?? idle?.error;
    const reason = error?.message ?? (idle?.outcome !== undefined && idle.outcome !== "succeeded" ? `execution ${idle.outcome}` : "no assistant text");
    throw new Error(`opencode completion failed: ${reason}`);
  }
  const usage = usageOf(reply);
  return {
    text,
    ...(reply?.model ? { model: `${reply.model.providerID}/${reply.model.id}` } : {}),
    ...(usage ? { usage } : {}),
    elapsedMs: Date.now() - started,
  };
}

function usageOf(message: WireMessage | undefined): TurnUsage | undefined {
  const tokens = message?.tokens;
  if (!tokens) return undefined;
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output + tokens.reasoning,
    cacheReadTokens: tokens.cache.read,
    cacheWriteTokens: tokens.cache.write,
    ...(typeof message.cost === "number" ? { costUsd: message.cost } : {}),
  };
}
