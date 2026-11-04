import { memoByRef } from "@tide/client";
import type { ReadModel, Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { plural } from "../../lib/format.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Popover } from "../ui/Popover.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { showSideChat } from "./useSideChat.ts";
import styles from "./ThreadHeader.module.css";

const sideChatsOf = memoByRef((threads: ReadModel["threads"], parentId: string): Thread[] =>
  Object.values(threads)
    .filter((t) => t.role === "side" && t.parentThreadId === parentId && t.archivedAt === undefined)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
);

/** R16: a thread's side chats, oldest first; the same array while `model.threads` is unchanged. */
export function selectSideChats(model: ReadModel, parentId: string): Thread[] {
  return sideChatsOf(model.threads, parentId);
}

/** "n side chats": every side chat of the thread, so a closed tab stays one click away. */
export function SideChatsPopover({ threadId }: { threadId: string }) {
  const sides = useModel((s) => selectSideChats(s.model, threadId));
  if (sides.length === 0) return null;
  return (
    <Popover
      variant="quiet"
      label={
        <>
          <Icon name="chat" size={12} />
          {plural(sides.length, "side chat")}
        </>
      }
      title="Side chats of this thread"
    >
      {(close) => (
        <ul className={styles.delegates}>
          {sides.map((side) => (
            <li key={side.id}>
              <Button
                variant="quiet"
                className={styles.delegateRow}
                onClick={() => {
                  close();
                  showSideChat(threadId, side.id);
                }}
              >
                <StatusGlyph status={side.status} {...(side.attention ? { attention: side.attention } : {})} />
                <span className={styles.delegateTitle}>{side.title}</span>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Popover>
  );
}
