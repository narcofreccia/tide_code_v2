import { observeVisibleAnimation } from "../../lib/visibleAnimation.ts";
import styles from "./LiveLabel.module.css";

/**
 * A status label that is still happening ("Thinking…", a running tool's name):
 * the muted text with a soft full-colour window sweeping across it. The bright
 * copy is drawn from `data-label` by CSS, so the DOM — and copy/paste, and
 * screen readers — see the text once. Paused off screen and in hidden tabs.
 */
export function LiveLabel({ text, className }: { text: string; className?: string | undefined }) {
  return (
    <span
      ref={observeVisibleAnimation}
      className={className === undefined ? styles.live : `${styles.live} ${className}`}
      data-live-label=""
    >
      {text}
      <span className={styles.sweep} aria-hidden="true">
        <span className={styles.copy} data-label={text} />
      </span>
    </span>
  );
}
