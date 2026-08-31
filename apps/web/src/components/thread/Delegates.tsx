import { selectDelegates } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Popover } from "../ui/Popover.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import styles from "./ThreadHeader.module.css";

/** "↳ n delegated": the threads this one spawned, with a jump into each. */
export function DelegatesPopover({ threadId }: { threadId: string }) {
  const model = useModel((s) => s.model);
  const delegates = selectDelegates(model, threadId);
  const selectThread = useUi((s) => s.selectThread);
  if (delegates.length === 0) return null;
  return (
    <Popover variant="quiet" label={`↳ ${delegates.length} delegated`} title="Threads this one delegated">
      {(close) => (
        <ul className={styles.delegates}>
          {delegates.map((d: Thread) => (
            <li key={d.id}>
              <Button
                variant="quiet"
                className={styles.delegateRow}
                onClick={() => {
                  close();
                  selectThread(d.id);
                }}
              >
                <StatusGlyph status={d.status} {...(d.attention ? { attention: d.attention } : {})} />
                <span className={styles.delegateTitle}>{d.title}</span>
                <span className={styles.stat}>{d.provider}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}

/** The other end of the link: where a delegate came from. */
export function DelegatedBy({ parentThreadId }: { parentThreadId: string }) {
  const parent = useModel((s) => s.model.threads[parentThreadId]);
  const selectThread = useUi((s) => s.selectThread);
  return (
    <button type="button" className={styles.delegatedBy} onClick={() => selectThread(parentThreadId)}>
      delegated by {parent?.title ?? parentThreadId}
    </button>
  );
}
