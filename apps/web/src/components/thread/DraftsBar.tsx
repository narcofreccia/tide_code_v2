import { memo } from "react";
import { applyStash, removeStash, stashDraft, type StashedDraft } from "../../state/drafts.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Icon } from "../ui/Icon.tsx";
import styles from "./Composer.module.css";

interface Props {
  threadId: string;
  restored: boolean;
  hasText: boolean;
  stash: StashedDraft[];
  open: boolean;
  onOpen: (open: boolean) => void;
}

const preview = (d: StashedDraft): string => {
  const line = d.text.trim().split("\n")[0] ?? "";
  const label = line.length > 48 ? `${line.slice(0, 48)}…` : line;
  return d.images.length > 0 ? `${label || "(images)"} +${d.images.length} img` : label;
};

/** Footer controls for the composer draft: "Draft" hint, Stash, Apply stash list. Memoized: keystrokes only flip `hasText`. */
export const DraftsBar = memo(function DraftsBar({ threadId, restored, hasText, stash, open, onOpen }: Props) {
  return (
    <span className={styles.drafts}>
      {restored ? <span className={styles.draftHint}>Draft</span> : null}
      {hasText ? (
        <Button variant="quiet" title="Stash this prompt to apply in any thread" onClick={() => stashDraft(threadId)}>
          <span>Stash</span>
          <Kbd>⌘⇧S</Kbd>
        </Button>
      ) : stash.length > 0 ? (
        <Button variant="quiet" title="Apply the latest stash" onClick={() => onOpen(!open)} aria-expanded={open}>
          <span>Apply stash · {stash.length}</span>
          <Kbd>⌘⇧S</Kbd>
        </Button>
      ) : null}
      {open && !hasText && stash.length > 0 ? (
        <ul className={styles.stashList} aria-label="Stashed prompts">
          {[...stash].reverse().map((d) => (
            <li key={d.id} className={styles.stashItem}>
              <button
                type="button"
                className={styles.stashPick}
                onClick={() => {
                  applyStash(threadId, d.id);
                  onOpen(false);
                }}
              >
                {preview(d)}
              </button>
              <button type="button" className={styles.stashDrop} aria-label="Discard stash" onClick={() => removeStash(d.id)}>
                <Icon name="close" size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </span>
  );
});
