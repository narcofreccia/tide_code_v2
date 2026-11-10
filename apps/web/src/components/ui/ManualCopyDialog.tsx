import { useEffect, useRef } from "react";
import { closeManualCopy, useManualCopy } from "../../lib/clipboard.ts";
import { Button } from "./Button.tsx";
import { Dialog } from "./Dialog.tsx";
import dialogStyles from "./Dialog.module.css";
import styles from "./ManualCopyDialog.module.css";

/** Shown after a failed copy: the text, selected, for ⌘C / long-press → Copy. */
export function ManualCopyDialog() {
  const text = useManualCopy((s) => s.text);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (text === undefined) return;
    area.current?.focus();
    area.current?.select();
  }, [text]);
  if (text === undefined) return null;
  return (
    <Dialog title="Copy by hand" onCancel={closeManualCopy} size="md">
      <textarea
        ref={area}
        className={styles.text}
        aria-label="Text to copy"
        readOnly
        value={text}
        rows={Math.min(12, Math.max(2, text.split("\n").length))}
        onFocus={(e) => e.currentTarget.select()}
      />
      <div className={dialogStyles.actions}>
        <Button variant="primary" onClick={closeManualCopy}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
