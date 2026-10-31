import type { AttentionKind, Thread } from "@tide/contracts";
import { threadStateKey, threadStateLabel, type ThreadStateKey } from "../../lib/vocab.ts";
import { observeVisibleAnimation } from "../../lib/visibleAnimation.ts";
import styles from "./StatusGlyph.module.css";

/**
 * Running glyphs blink together: one document-level `animationiteration` listener
 * restarts every registered glyph's animations when one of them loops, so a rail
 * full of running threads pulses in step instead of shimmering out of phase.
 */
const pulsing = new Set<HTMLElement>();
let syncListening = false;

function restart(el: HTMLElement): void {
  if (typeof el.getAnimations !== "function") return;
  for (const animation of el.getAnimations()) animation.currentTime = 0;
}

let lastSync = Number.NEGATIVE_INFINITY;

/**
 * The first glyph to loop in a cycle leads (a paused off-screen leader would stall
 * a fixed one); the echoes from glyphs that looped in the same moment are skipped.
 */
export function synchronizeStatusPulse(event: Event): void {
  if (!(event.target instanceof HTMLElement) || !pulsing.has(event.target)) return;
  if (event.timeStamp - lastSync < 100) return;
  lastSync = event.timeStamp;
  for (const el of pulsing) restart(el);
}

/** Ref callback for a running glyph: off-screen pause plus the shared sync. */
export function pulseRef(el: HTMLElement | null): (() => void) | undefined {
  if (el === null) return undefined;
  const unobserve = observeVisibleAnimation(el);
  pulsing.add(el);
  if (!syncListening && typeof document !== "undefined") {
    document.addEventListener("animationiteration", synchronizeStatusPulse, true);
    syncListening = true;
  }
  return () => {
    unobserve();
    pulsing.delete(el);
    if (pulsing.size === 0 && syncListening) {
      document.removeEventListener("animationiteration", synchronizeStatusPulse, true);
      syncListening = false;
    }
  };
}

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
      ref={state === "running" ? pulseRef : undefined}
      className={`${styles.glyph} ${TONE[state]}`}
      data-pulse={state === "running" ? "" : undefined}
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
