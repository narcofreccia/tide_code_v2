import type { AttentionKind, Thread } from "@tide/contracts";
import { threadStateKey, threadStateLabel, type ThreadStateKey } from "../../lib/vocab.ts";
import styles from "./StatusGlyph.module.css";

/** ○ idle · ● running · ◐ needs you · ✕ error · ⏸ interrupted · ◔ limited · ☾ snoozed · ✓ merged */
export const STATE_GLYPH: Record<ThreadStateKey, string> = {
  idle: "○",
  running: "●",
  needs: "◐",
  error: "✕",
  interrupted: "⏸",
  interrupting: "◑",
  limited: "◔",
  snoozed: "☾",
  merged: "✓",
};

const TONE: Record<ThreadStateKey, string> = {
  idle: styles.idle ?? "",
  running: styles.running ?? "",
  needs: styles.needsYou ?? "",
  error: styles.error ?? "",
  interrupted: styles.interrupted ?? "",
  interrupting: styles.interrupting ?? "",
  limited: styles.limited ?? "",
  snoozed: styles.snoozed ?? "",
  merged: styles.merged ?? "",
};

const ATTENTION_LABEL: Record<AttentionKind, string> = {
  approval: "needs you: approval",
  question: "needs you: question",
  plan: "needs you: plan ready",
};

/** The bare glyph for a state key; used by chips and the legend. */
export function StateGlyph({ state, label }: { state: ThreadStateKey; label?: string }) {
  return (
    <span
      className={`${styles.glyph} ${TONE[state]}`}
      {...(label === undefined ? { "aria-hidden": true } : { title: label, "aria-label": label, role: "img" })}
    >
      {STATE_GLYPH[state]}
    </span>
  );
}

/**
 * `interrupting` wins over everything (the turn is being stopped), then
 * `attention`: a waiting thread reads as needs-you before its run state. An
 * idle thread whose branch landed on its base reads as `✓ merged`.
 */
export function StatusGlyph({
  status,
  attention,
  interrupting,
  merged,
  limited,
  snoozed,
  label: override,
}: {
  status: Thread["status"];
  attention?: AttentionKind;
  interrupting?: boolean;
  merged?: boolean;
  limited?: boolean;
  snoozed?: boolean;
  /** tooltip / accessible name; defaults to the lowercase word */
  label?: string;
}) {
  const showMerged = merged === true && status === "idle" && attention === undefined && interrupting !== true;
  const state: ThreadStateKey =
    interrupting === true
      ? "interrupting"
      : attention
        ? "needs"
        : limited === true
          ? "limited"
          : snoozed === true
            ? "snoozed"
            : showMerged
              ? "merged"
              : status;
  const label =
    override ??
    (state === "interrupting"
      ? "interrupting…"
      : attention && state === "needs"
        ? ATTENTION_LABEL[attention]
        : state === "merged"
          ? "merged"
          : state === "needs" || state === "limited" || state === "snoozed"
            ? THREAD_LABEL_FALLBACK[state]
            : status);
  return <StateGlyph state={state} label={label} />;
}

const THREAD_LABEL_FALLBACK = { needs: "needs you", limited: "limited", snoozed: "snoozed" } as const;

/** The glyph for a thread; its tooltip is `threadStateLabel`, the same word the header chip and status bar show. */
export function ThreadGlyph({ thread }: { thread: Thread }) {
  return <StateGlyph state={threadStateKey(thread)} label={threadStateLabel(thread)} />;
}
