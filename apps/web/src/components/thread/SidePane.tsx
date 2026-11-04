import { useEffect, useRef } from "react";
import { useModel } from "../../state/model.ts";
import { requestDelete } from "../../lib/threadActions.ts";
import { closeSideTab } from "../../state/workbench.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { Composer } from "./Composer.tsx";
import { Stream } from "./Stream.tsx";
import { bringBack, bringBackBlocked, closeSideChat } from "./useSideChat.ts";
import styles from "./SidePane.module.css";

/**
 * R16: a side chat in its parent's workbench — its own stream and composer, a way to
 * quote its last answer back into the parent's draft, and its lifecycle (Delete, Close).
 * The column is not `[data-thread-column]`: Esc and `y` / `n` stay with the parent.
 */
export function SidePane({ parentId, sideId }: { parentId: string; sideId: string }) {
  const side = useModel((s) => s.model.threads[sideId]);
  const blocked = useModel((s) => bringBackBlocked(s.model, sideId));
  const seen = useRef(false);

  // deleted (here, from the dialog or elsewhere): its tab goes with it
  useEffect(() => {
    if (side) seen.current = true;
    else if (seen.current) closeSideTab(parentId, sideId);
  }, [side, parentId, sideId]);

  if (!side) {
    return (
      <section className={styles.pane} aria-label="Side chat">
        <p className={styles.gone}>This side chat is gone.</p>
      </section>
    );
  }

  return (
    <section className={styles.pane} aria-label={`Side chat ${side.title}`}>
      <header className={styles.head}>
        <StatusGlyph status={side.status} {...(side.attention ? { attention: side.attention } : {})} />
        <span className={styles.title} title={side.title}>
          {side.title}
        </span>
        <Button
          variant="quiet"
          disabled={blocked !== undefined}
          title={blocked === undefined ? "Quote the last answer into the main thread's draft" : `Bring back: ${blocked}`}
          onClick={() => bringBack(sideId, parentId)}
        >
          <Icon name="arrowUp" size={12} />
          Bring back
        </Button>
        <Button variant="quietDanger" onClick={() => requestDelete(side)}>
          <Icon name="trash" size={12} />
          Delete
        </Button>
        <Button variant="quiet" aria-label="Close side chat" title="Close (an unused side chat is deleted)" onClick={() => closeSideChat(parentId, sideId)}>
          <Icon name="close" size={12} />
        </Button>
      </header>
      <Stream threadId={side.id} provider={side.provider} hotkeys={false} />
      {side.archivedAt === undefined ? <Composer thread={side} scope="side" /> : null}
    </section>
  );
}
