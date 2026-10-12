import { isThreadMerged } from "@tide/client";
import type { AttentionKind, Thread } from "@tide/contracts";
import styles from "./StatusGlyph.module.css";

/** ○ idle · ● running · ◐ needs you · ✕ error · ⏸ interrupted · ✓ merged */
const GLYPH: Record<Thread["status"], string> = {
  idle: "○",
  running: "●",
  interrupted: "⏸",
  error: "✕",
};

const ATTENTION_LABEL: Record<AttentionKind, string> = {
  approval: "needs you: approval",
  question: "needs you: question",
  plan: "needs you: plan ready",
};

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
}: {
  status: Thread["status"];
  attention?: AttentionKind;
  interrupting?: boolean;
  merged?: boolean;
}) {
  const showMerged = merged === true && status === "idle" && attention === undefined && interrupting !== true;
  const label =
    interrupting === true ? "interrupting…" : attention ? ATTENTION_LABEL[attention] : showMerged ? "merged" : status;
  const tone =
    interrupting === true
      ? styles.interrupting
      : attention
        ? styles.needsYou
        : showMerged
          ? styles.merged
          : (styles[status] ?? "");
  const glyph = interrupting === true ? "◑" : attention ? "◐" : showMerged ? "✓" : GLYPH[status];
  return (
    <span className={`${styles.glyph} ${tone}`} title={label} aria-label={label} role="img">
      {glyph}
    </span>
  );
}

/** The glyph for a thread, with every flag it carries wired in. */
export function ThreadGlyph({ thread }: { thread: Thread }) {
  return (
    <StatusGlyph
      status={thread.status}
      {...(thread.attention ? { attention: thread.attention } : {})}
      {...(thread.interrupting === true ? { interrupting: true } : {})}
      {...(isThreadMerged(thread) ? { merged: true } : {})}
    />
  );
}
