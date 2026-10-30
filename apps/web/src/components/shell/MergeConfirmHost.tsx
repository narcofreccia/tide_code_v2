import { useModel } from "../../state/model.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { useUi } from "../../state/ui.ts";
import { mergeBackThread } from "../../lib/threadActions.ts";
import type { MergeStrategy } from "@tide/contracts";
import { ConfirmDialog } from "../ui/Dialog.tsx";

const STRATEGY_WORDS: Record<MergeStrategy, string> = { merge: "a merge commit", squash: "one squashed commit", rebase: "a rebase" };

/** The rail's merge-back confirmation (`settings.git.confirmMergeBack`); the server applies the defaults. */
export function MergeConfirmHost() {
  const threadId = useUi((s) => s.mergeConfirmThreadId);
  const setMergeConfirm = useUi((s) => s.setMergeConfirm);
  const thread = useModel((s) => (threadId === null ? undefined : s.model.threads[threadId]));
  const git = useServerSettings((s) => s.settings.git);
  if (threadId === null || thread === undefined) return null;
  const how = STRATEGY_WORDS[git.mergeStrategy];
  return (
    <ConfirmDialog
      title="Merge back?"
      body={
        <>
          Merge <strong>{thread.branch}</strong> into its base as {how}
          {git.deleteBranchOnMerge ? ", then remove the branch and its worktree." : "."}
        </>
      }
      confirmLabel="Merge back"
      onCancel={() => setMergeConfirm(null)}
      onConfirm={() => {
        setMergeConfirm(null);
        void mergeBackThread(threadId, { confirmed: true });
      }}
    />
  );
}
