import { useState } from "react";
import type { ProviderKind, Thread, Turn } from "@tide/contracts";
import { forkThread, rollbackThread } from "../../lib/turnActions.ts";
import { providerStatus, useProviders } from "../../state/providers.ts";
import { Checkbox } from "../ui/Choice.tsx";
import { ConfirmDialog, Dialog } from "../ui/Dialog.tsx";
import { Button } from "../ui/Button.tsx";
import { HarnessFields } from "./ProviderPicker.tsx";
import styles from "./ThreadDialogs.module.css";

/** Undo a turn and everything after it; files are restored only when a checkpoint exists. */
export function RollbackDialog({ thread, turn, onClose }: { thread: Thread; turn: Turn; onClose: () => void }) {
  const providers = useProviders();
  const canRestore = thread.worktreePath !== undefined && turn.checkpoint?.before !== undefined;
  const [restoreFiles, setRestoreFiles] = useState(canRestore);
  const forgets = providerStatus(providers, thread.provider)?.caps.rollback === true;
  return (
    <ConfirmDialog
      title="Roll back to before this turn?"
      confirmLabel="Roll back"
      onCancel={onClose}
      onConfirm={() => {
        void rollbackThread(thread.id, turn.id, restoreFiles && canRestore);
        onClose();
      }}
      body={
        <span className={styles.options}>
          <span>Undo this turn and everything after it.</span>
          <Checkbox
            className={styles.option}
            checked={restoreFiles && canRestore}
            disabled={!canRestore}
            {...(canRestore ? {} : { title: "Needs a worktree and a checkpoint taken before this turn" })}
            onChange={(e) => setRestoreFiles(e.target.checked)}
          >
            Restore files
          </Checkbox>
          <span>
            {forgets
              ? `${thread.provider} forgets these turns.`
              : `${thread.provider} cannot forget turns; Tide hides them and the harness may still remember them.`}
          </span>
        </span>
      }
    />
  );
}

/** New thread continuing from a settled turn: title, harness, model, worktree. */
export function ForkDialog({ thread, turn, onClose }: { thread: Thread; turn: Turn; onClose: () => void }) {
  const [title, setTitle] = useState(`${thread.title} (fork)`);
  const [provider, setProvider] = useState<ProviderKind>(thread.provider);
  const [model, setModel] = useState(thread.model ?? "");
  const [useWorktree, setUseWorktree] = useState(true);
  const submit = (): void => {
    const trimmed = title.trim();
    void forkThread(thread.id, turn.id, {
      ...(trimmed === "" ? {} : { title: trimmed }),
      provider,
      model,
      useWorktree,
    });
    onClose();
  };
  return (
    <Dialog title="Fork from here" onCancel={onClose}>
      <label className={styles.option}>
        <span className={styles.branch}>title</span>
        <input
          className={styles.field}
          aria-label="Fork title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <HarnessFields
        name="Fork"
        provider={provider}
        model={model}
        onChange={(patch) => {
          if (patch.provider !== undefined) setProvider(patch.provider);
          if (patch.model !== undefined) setModel(patch.model);
        }}
      />
      <Checkbox className={styles.option} checked={useWorktree} onChange={(e) => setUseWorktree(e.target.checked)}>
        Use a worktree
      </Checkbox>
      {provider === thread.provider ? null : (
        <span className={styles.branch}>History is handed over to {provider} as text (lossy: no tool state).</span>
      )}
      <div className={styles.actions}>
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" onClick={submit}>
          Fork
        </Button>
      </div>
    </Dialog>
  );
}
