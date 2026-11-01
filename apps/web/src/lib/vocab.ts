import { isThreadMerged } from "@tide/client";
import type { InteractionMode, ProviderKind, ProviderStatusDto, RuntimeMode, Thread } from "@tide/contracts";
import { relativeUntil } from "./relativeTime.ts";

/** The four harnesses Tide ships a driver for; each always has a default instance whose id is the kind. */
export const BUNDLED_PROVIDERS: ProviderKind[] = ["claude", "codex", "opencode", "pi"];

/** Every kind; `acp` has no default instance — each ACP agent is its own configured instance. */
export const PROVIDERS: ProviderKind[] = [...BUNDLED_PROVIDERS, "acp"];

/** Display names; the wire uses the lowercase kind. */
export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
  acp: "ACP agent",
};

/** One-letter harness mark, used where a full name does not fit (rail tooltips). */
export const PROVIDER_MONOGRAMS: Record<ProviderKind, string> = { claude: "C", codex: "X", opencode: "O", pi: "P", acp: "A" };

export function isProviderKind(value: string): value is ProviderKind {
  return (PROVIDERS as string[]).includes(value);
}

/** The kind an instance id belongs to: `"codex:work"` → `codex`; undefined when it names none. */
export function kindOfId(id: string): ProviderKind | undefined {
  const head = id.split(":")[0] ?? "";
  return isProviderKind(head) ? head : undefined;
}

/** The instance a thread runs on; absent `providerId` means the kind's default instance. */
export function providerIdOf(thread: { provider: ProviderKind; providerId?: string }): string {
  return thread.providerId ?? thread.provider;
}

/**
 * Display name of an instance: the server's label (`Codex · work`, `Gemini CLI`),
 * else the kind's name for a bare kind, else the id itself.
 */
export function instanceLabel(providers: readonly ProviderStatusDto[], id: string): string {
  const exact = providers.find((p) => p.id === id);
  if (exact?.label) return exact.label;
  if (isProviderKind(id)) return PROVIDER_LABELS[id];
  return id;
}

/** A thread's harness as the user reads it; the instance label when it is not the kind's default. */
export function threadHarnessLabel(
  providers: readonly ProviderStatusDto[],
  thread: { provider: ProviderKind; providerId?: string },
): string {
  const id = providerIdOf(thread);
  return id === thread.provider ? PROVIDER_LABELS[thread.provider] : instanceLabel(providers, id);
}
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
/** `name` is a kind or an instance label */
const nameOf = (name: string): string => (isProviderKind(name) ? PROVIDER_LABELS[name] : name);
export const defaultModelHint = (name: string): string => `Whatever ${nameOf(name)} picks`;
/** The hint on the model the harness itself marks as its default. */
export const harnessDefaultHint = (name: string): string => `${nameOf(name)}'s default`;

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
  | "merged"
  /** the turn settled but sub-agents it launched still work in the background */
  | "background";

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
  background: "Working in background",
};

/**
 * Precedence: stopping, waiting on the user, limited, snoozed, then run state; a thread
 * between turns with sub-agents still working (`background` = how many) reads Background,
 * an idle merged branch reads Merged.
 */
export function threadStateKey(thread: Thread, now: number = Date.now(), background = 0): ThreadStateKey {
  if (thread.interrupting === true) return "interrupting";
  if (thread.attention) return "needs";
  if (thread.limited) return "limited";
  if (thread.snoozedUntil !== undefined && thread.snoozedUntil > now) return "snoozed";
  if (background > 0 && thread.status !== "running") return "background";
  if (thread.status === "idle" && isThreadMerged(thread)) return "merged";
  return thread.status;
}

/** `1 agent in background`, `3 agents in background` */
export function backgroundAgentsText(count: number): string {
  return `${count} ${count === 1 ? "agent" : "agents"} in background`;
}

/** `1 sub-agent working in the background` — the rail's tooltip. */
export function backgroundAgentsTip(count: number): string {
  return `${count} ${count === 1 ? "sub-agent" : "sub-agents"} working in the background`;
}

/** `Idle`, `Running`, `Needs you`, `Limited · resets in 2h`, … */
export function threadStateLabel(thread: Thread, now: number = Date.now(), background = 0): string {
  const key = threadStateKey(thread, now, background);
  if (key === "background") return `Working · ${backgroundAgentsText(background)}`;
  if (key === "limited") {
    const at = thread.limited?.resetsAt;
    return at === undefined ? "Limited" : `Limited · resets ${relativeUntil(at, now)}`;
  }
  if (key === "snoozed" && thread.snoozedUntil !== undefined) {
    return `Snoozed · until ${new Date(thread.snoozedUntil).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
  return THREAD_STATE_WORDS[key];
}
