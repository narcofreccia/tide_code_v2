import { useSelectedThread } from "../../state/hooks.ts";
import { ThreadLinkChips } from "../thread/ThreadLinkChips.tsx";
import { ThreadPills } from "../thread/ThreadPills.tsx";
import { BottomSheet } from "./BottomSheet.tsx";
import { useMobileNav } from "./mobileNav.ts";
import styles from "./BottomSheet.module.css";

/** The composer's pill row on a phone: collapsed behind the top bar's ⚙ into one sheet. */
export function ThreadSheet() {
  const open = useMobileNav((s) => s.sheetOpen);
  const thread = useSelectedThread();
  if (!open || !thread) return null;
  return (
    <BottomSheet title="Thread settings" onClose={() => useMobileNav.getState().setSheetOpen(false)}>
      <div className={styles.wrap}>
        <ThreadPills thread={thread} />
        <ThreadLinkChips threadId={thread.id} />
      </div>
    </BottomSheet>
  );
}
