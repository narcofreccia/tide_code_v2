import type { AttentionKind, Thread } from "@tide/contracts";
import styles from "./StatusGlyph.module.css";

/** ○ idle · ● running · ◐ needs you · ✕ error · ⏸ interrupted */
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
 * `attention`: a waiting thread reads as needs-you before its run state.
 */
export function StatusGlyph({
  status,
  attention,
  interrupting,
}: {
  status: Thread["status"];
  attention?: AttentionKind;
  interrupting?: boolean;
}) {
  const label = interrupting === true ? "interrupting…" : attention ? ATTENTION_LABEL[attention] : status;
  const tone = interrupting === true ? styles.interrupting : attention ? styles.needsYou : (styles[status] ?? "");
  return (
    <span className={`${styles.glyph} ${tone}`} title={label} aria-label={label} role="img">
      {interrupting === true ? "◑" : attention ? "◐" : GLYPH[status]}
    </span>
  );
}
