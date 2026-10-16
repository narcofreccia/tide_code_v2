import { isThreadMerged } from "@tide/client";
import type { InteractionMode, ProviderKind, RuntimeMode, Thread } from "@tide/contracts";
import { relativeUntil } from "./relativeTime.ts";

export const PROVIDERS: ProviderKind[] = ["claude", "codex", "opencode", "pi"];

/** Display names; the wire uses the lowercase kind. */
export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};
export const RUNTIME_MODES: RuntimeMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
export const INTERACTION_MODES: InteractionMode[] = ["default", "plan"];

export const RUNTIME_MODE_LABELS: Record<RuntimeMode, string> = {
  "approval-required": "Ask first",
  "auto-accept-edits": "Auto-edit",
  auto: "Auto",
  "full-access": "Full access",
};
export const RUNTIME_MODE_HINTS: Record<RuntimeMode, string> = {
  "approval-required": "Asks before every edit and command",
  "auto-accept-edits": "Edits files freely, asks before commands",
  auto: "The agent decides when to ask",
  "full-access": "Never asks — use with care",
};

export const INTERACTION_LABELS: Record<InteractionMode, string> = { default: "Build", plan: "Plan" };
export const INTERACTION_HINTS: Record<InteractionMode, string> = {
  default: "Makes changes",
  plan: "Proposes a plan first; changes nothing until you approve",
};

export const DEFAULT_MODEL_LABEL = "Default model";
export const defaultModelHint = (provider: ProviderKind): string => `Whatever ${PROVIDER_LABELS[provider]} picks`;

/** One status language: every surface (header chip, status bar, rail glyph) derives from this. */
export type ThreadStateKey =
  | "idle"
  | "running"
  | "needs"
  | "error"
  | "interrupted"
  | "interrupting"
  | "limited"
  | "snoozed"
  | "merged";

export const THREAD_STATE_WORDS: Record<ThreadStateKey, string> = {
  idle: "Idle",
  running: "Running",
  needs: "Needs you",
  error: "Error",
  interrupted: "Interrupted",
  interrupting: "interrupting…",
  limited: "Limited",
  snoozed: "Snoozed",
  merged: "Merged",
};

/** Precedence: stopping, waiting on the user, limited, snoozed, then run state; an idle merged branch reads Merged. */
export function threadStateKey(thread: Thread, now: number = Date.now()): ThreadStateKey {
  if (thread.interrupting === true) return "interrupting";
  if (thread.attention) return "needs";
  if (thread.limited) return "limited";
  if (thread.snoozedUntil !== undefined && thread.snoozedUntil > now) return "snoozed";
  if (thread.status === "idle" && isThreadMerged(thread)) return "merged";
  return thread.status;
}

/** `Idle`, `Running`, `Needs you`, `Limited · resets in 2h`, … */
export function threadStateLabel(thread: Thread, now: number = Date.now()): string {
  const key = threadStateKey(thread, now);
  if (key === "limited") {
    const at = thread.limited?.resetsAt;
    return at === undefined ? "Limited" : `Limited · resets ${relativeUntil(at, now)}`;
  }
  if (key === "snoozed" && thread.snoozedUntil !== undefined) {
    return `Snoozed · until ${new Date(thread.snoozedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return THREAD_STATE_WORDS[key];
}
