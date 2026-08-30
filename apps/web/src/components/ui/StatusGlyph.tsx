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

/** `attention` wins over the run state: a waiting thread reads as needs-you. */
export function StatusGlyph({ status, attention }: { status: Thread["status"]; attention?: AttentionKind }) {
  const label = attention ? ATTENTION_LABEL[attention] : status;
  const tone = attention ? styles.needsYou : (styles[status] ?? "");
  return (
    <span className={`${styles.glyph} ${tone}`} title={label} aria-label={label} role="img">
      {attention ? "◐" : GLYPH[status]}
    </span>
  );
}
