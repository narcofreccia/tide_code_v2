import type { ImageInput, LimitWindow, ReadModel, TurnInput } from "@tide/contracts";
import { attachmentFooter } from "../workspace/attachments.ts";
import type { CancelTimer } from "./openTurn.ts";

// Per-thread and per-turn bookkeeping of the provider reactor.

export interface ThreadState {
  /** one turn at a time per thread; different threads run concurrently */
  queue: Promise<void>;
  /** `${turnId}:${driver activity key}` -> activity id, so updates land on the same row */
  activityIds: Map<string, string>;
  /** `${turnId}:${messageKey}` -> message id, so deltas assemble into one message */
  messageIds: Map<string, string>;
  /**
   * childKey (and `task:<taskId>`) -> the sub-agent's row and the turn it was launched in, kept across turns: a
   * background sub-agent reports in a later (harness-initiated) turn, and its row must settle
   * in place rather than appear twice. Its own tool rows join that turn too.
   */
  children: Map<string, { id: string; turnId: string }>;
  /** R14: idle sub-agent activity lands in arrival order (each upsert merges onto the previous one) */
  idleQueue: Promise<void>;
}

/** What one running turn learned that matters after it settles. */
export interface TurnRun {
  /** the harness said the subscription window is exhausted */
  limited?: { resetsAt?: number; note?: string; window?: LimitWindow };
  /** how the turn settled */
  status?: "completed" | "interrupted" | "error";
}

/** The prompt text the harness gets: the typed text plus the "Attached files" footer for uploaded files. */
export const textOf = (m: { text: string; attachments?: ReadonlyArray<{ mediaType: string; bytes: number; name?: string; path?: string }> }): string => m.text + attachmentFooter(m.attachments);

/** Drops every `${turnId}:…` entry of a settled turn: harness keys (request ids, tool ids) repeat across turns. */
export function dropTurnKeys(map: Map<string, string>, turnId: string): void {
  const prefix = `${turnId}:`;
  for (const key of [...map.keys()]) if (key.startsWith(prefix)) map.delete(key);
}

/** A turn's input read back from the model (a turn this reactor never saw requested); image bytes come from `imagesFor`. */
export function storedInput(model: ReadModel, threadId: string, turnId: string, imagesFor: ((threadId: string, turnId: string) => ImageInput[] | undefined) | undefined): TurnInput {
  const message = (model.threadMessages[threadId] ?? []).map((id) => model.messages[id]).find((m) => m?.turnId === turnId && m.role === "user");
  const images = imagesFor?.(threadId, turnId);
  return { text: message !== undefined ? textOf(message) : "", ...(images !== undefined && images.length > 0 ? { images } : {}) };
}

export function newThreadState(): ThreadState {
  return { queue: Promise.resolve(), activityIds: new Map(), messageIds: new Map(), children: new Map(), idleQueue: Promise.resolve() };
}

export const realTimer = (fn: () => void, ms: number): CancelTimer => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};
