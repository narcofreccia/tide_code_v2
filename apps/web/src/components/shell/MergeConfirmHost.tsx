import type { MergeStrategy } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";
import { mergeBackThreads } from "../../lib/inboxActions.ts";
import { mergeTarget } from "../../lib/merge.ts";
import { mergeBackThread } from "../../lib/threadActions.ts";
import { ConfirmDialog } from "../ui/Dialog.tsx";
import styles from "./MergeConfirmHost.module.css";

export const STRATEGY_WORDS: Record<MergeStrategy, string> = { merge: "a merge commit", squash: "one squashed commit", rebase: "a rebase" };

/**
 * The merge-back confirmation: one thread from the rail (`settings.git.confirmMergeBack`) or
 * the rail selection's batch (always confirmed). The server applies the defaults.
 */
export function MergeConfirmHost() {
  const single = useUi((s) => s.mergeConfirmThreadId);
  const many = useUi((s) => s.mergeConfirmThreadIds);
  const setMergeConfirm = useUi((s) => s.setMergeConfirm);
  const setMany = useUi((s) => s.setMergeConfirmMany);
  const ids = many ?? (single === null ? null : [single]);
  const known = useModel((s) => (ids ?? []).filter((id) => s.model.threads[id] !== undefined).join("\n"));
  const threads = known === "" ? [] : known.split("\n").flatMap((id) => useModel.getState().model.threads[id] ?? []);
  const git = useServerSettings((s) => s.settings.git);
  if (ids === null || threads.length === 0) return null;
  const how = STRATEGY_WORDS[git.mergeStrategy];
  const tail = git.deleteBranchOnMerge ? ", then remove each branch and its worktree." : ".";
  const close = (): void => (many ? setMany(null) : setMergeConfirm(null));
  const first = threads[0];
  return (
    <ConfirmDialog
      title={threads.length > 1 ? `Merge ${threads.length} branches?` : "Merge back?"}
      body={
        threads.length > 1 ? (
          <>
            Merge {threads.length} branches into their bases as {how}
            {tail}
            <ul className={styles.list}>
              {threads.map((t) => (
                <li key={t.id}>{mergeTarget(t)}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            Merge <strong>{first?.branch}</strong> into its base as {how}
            {git.deleteBranchOnMerge ? ", then remove the branch and its worktree." : "."}
          </>
        )
      }
      confirmLabel={threads.length > 1 ? `Merge ${threads.length}` : "Merge back"}
      onCancel={close}
      onConfirm={() => {
        close();
        if (many) void mergeBackThreads(threads.map((t) => t.id));
        else if (single !== null) void mergeBackThread(single, { confirmed: true });
      }}
    />
  );
}
