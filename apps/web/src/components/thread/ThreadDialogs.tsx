import { useState } from "react";
import type { Thread } from "@tide/contracts";
import { archiveThread, detachWorktree } from "../../lib/threadActions.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import styles from "./ThreadDialogs.module.css";

/** Archiving a worktree thread asks what happens to the directory; the branch always stays. */
export function ArchiveThreadDialog({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const [keepWorktree, setKeepWorktree] = useState(false);
  return (
    <ConfirmDialog
      title={`Archive “${thread.title}”?`}
      confirmLabel="Archive"
      onCancel={onClose}
      onConfirm={() => {
        archiveThread(thread.id, keepWorktree);
        onClose();
      }}
      body={
        <span className={styles.options}>
          <span className={styles.path}>{thread.worktreePath}</span>
          <label className={styles.option}>
            <input
              type="radio"
              name="archive-worktree"
              checked={!keepWorktree}
              onChange={() => setKeepWorktree(false)}
            />
            Remove the worktree directory (branch is kept)
          </label>
          <label className={styles.option}>
            <input
              type="radio"
              name="archive-worktree"
              checked={keepWorktree}
              onChange={() => setKeepWorktree(true)}
            />
            Keep worktree
          </label>
        </span>
      }
    />
  );
}

/** Removes the worktree directory of a live thread; deleting the branch is opt-in. */
export function DetachWorktreeDialog({ thread, onClose }: { thread: Thread; onClose: () => void }) {
  const [deleteBranch, setDeleteBranch] = useState(false);
  const tideBranch = thread.branch?.startsWith("tide/") === true;
  return (
    <ConfirmDialog
      title="Detach worktree?"
      confirmLabel="Detach"
      onCancel={onClose}
      onConfirm={() => {
        detachWorktree(thread.id, deleteBranch && tideBranch);
        onClose();
      }}
      body={
        <span className={styles.options}>
          <span className={styles.path}>{thread.worktreePath}</span>
          <span>The thread stays; its working directory falls back to the project root.</span>
          <label
            className={styles.option}
            title={tideBranch ? undefined : "Only Tide-created tide/* branches can be deleted here"}
          >
            <input
              type="checkbox"
              checked={deleteBranch && tideBranch}
              disabled={!tideBranch}
              onChange={(e) => setDeleteBranch(e.target.checked)}
            />
            Also delete branch (tide/* only)
            {thread.branch ? <span className={styles.branch}>{thread.branch}</span> : null}
          </label>
        </span>
      }
    />
  );
}

/** Mounted by the app shell: renders whichever thread dialog `ui.threadDialog` names. */
export function ThreadDialogHost() {
  const dialog = useUi((s) => s.threadDialog);
  const setThreadDialog = useUi((s) => s.setThreadDialog);
  const thread = useModel((s) => (dialog ? s.model.threads[dialog.threadId] : undefined));
  if (!dialog || !thread) return null;
  const close = (): void => setThreadDialog(null);
  return dialog.kind === "archive" ? (
    <ArchiveThreadDialog thread={thread} onClose={close} />
  ) : (
    <DetachWorktreeDialog thread={thread} onClose={close} />
  );
}
