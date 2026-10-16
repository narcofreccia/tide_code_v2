import type { DomainEvent, EventOf, ImageInput, Message, ProviderKind, RuntimeMode, Turn, UserSettings } from "@tide/contracts";

/** The user settings the decider reads (supplied by the engine from `SettingsStore`). */
export interface DecideDefaults {
  /** default `resume` of a freshly limited thread */
  limitPolicy?: UserSettings["limitPolicy"];
  /** whether a delegate gets its own worktree when the caller does not say */
  worktreeByDefault?: boolean;
  /** model/mode per harness for threads the server builds without an explicit one */
  providerDefaults?: UserSettings["providerDefaults"];
}

export interface DecideContext extends DecideDefaults {
  now: number;
  newId: () => string;
  /** `TIDE_HANDOFF_TOKEN_CAP`: upper bound for a recorded handoff's history (see handoff/select.ts) */
  handoffCap?: number | string | undefined;
}

/** The settings default for `provider`, only where the command named nothing itself. */
export function providerDefault(ctx: DecideContext, provider: ProviderKind): { model?: string; mode?: RuntimeMode } {
  return ctx.providerDefaults?.[provider] ?? {};
}

export interface DecideError {
  code: string;
  message: string;
}

export type DecideResult =
  | { ok: true; events: DomainEvent[] }
  | { ok: false; error: DecideError };

export const ok = (...events: DomainEvent[]): DecideResult => ({ ok: true, events });
export const fail = (code: string, message: string): DecideResult => ({ ok: false, error: { code, message } });

export const isArchived = (e: { archivedAt?: number }): boolean => e.archivedAt !== undefined;

/** Attachment metadata kept on a user message (the image bytes ride only on the event). */
export function attachmentsOf(images: ImageInput[] | undefined): Pick<Message, "attachments"> {
  if (images === undefined || images.length === 0) return {};
  return { attachments: images.map((img) => ({ mediaType: img.mediaType, bytes: Math.floor((img.data.length * 3) / 4) })) };
}

/** Builds the `turn.requested` event that seeds a thread with `text`. */
export function turnRequested(
  threadId: string,
  text: string,
  ctx: DecideContext,
  notification?: Message["notification"],
): EventOf<"turn.requested"> {
  const turn: Turn = { id: ctx.newId(), threadId, status: "requested", requestedAt: ctx.now };
  const userMessage: Message = {
    id: ctx.newId(),
    threadId,
    turnId: turn.id,
    role: "user",
    text,
    ...(notification !== undefined ? { notification } : {}),
    createdAt: ctx.now,
  };
  return { type: "turn.requested", turn, userMessage };
}
