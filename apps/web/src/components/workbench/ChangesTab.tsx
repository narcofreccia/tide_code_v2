import { useEffect, useState } from "react";
import { selectActiveTurn, selectCheckpointTurns, selectThreadMessages } from "@tide/client";
import type { ReadModel, Thread } from "@tide/contracts";
import { useSelectedThread } from "../../state/hooks.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { ALL_CHANGES, resolveSelection, selectTurn, useTurnDiff, useVcs } from "../../state/vcs.ts";
import { Button } from "../ui/Button.tsx";
import { DiffHeader } from "./DiffHeader.tsx";
import { DiffPane } from "./DiffPane.tsx";
import { FileList } from "./FileList.tsx";
import styles from "./ChangesTab.module.css";

const EMPTY = "No changes in this thread yet.";

function firstPrompt(model: ReadModel, threadId: string): string {
  return selectThreadMessages(model, threadId).find((m) => m.role === "user")?.text ?? "";
}

/** `[` / `]` walk the checkpointed turns, unless the user is typing. */
function useTurnStepper(onStep: (delta: number) => void): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key !== "[" && event.key !== "]") return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      event.preventDefault();
      onStep(event.key === "]" ? 1 : -1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onStep]);
}

function ChangesFor({ thread }: { thread: Thread }) {
  const model = useModel((s) => s.model);
  const explicit = useVcs((s) => s.selection[thread.id]);
  const collapsed = useUi((s) => s.fileListCollapsed);
  const toggleFileList = useUi((s) => s.toggleFileList);
  const [picked, setPicked] = useState<string | undefined>(undefined);

  const turns = selectCheckpointTurns(model, thread.id);
  const selection = resolveSelection(model, thread.id, explicit);
  const running = selectActiveTurn(model, thread.id) !== undefined;
  const selectedTurn = selection && selection !== ALL_CHANGES ? model.turns[selection] : undefined;

  const diff = useTurnDiff(thread.id, selection);

  useTurnStepper((delta) => {
    if (turns.length === 0) return;
    const at = turns.findIndex((t) => t.id === selection);
    const next = turns[Math.min(turns.length - 1, Math.max(0, (at === -1 ? turns.length - 1 : at) + delta))];
    if (next) selectTurn(thread.id, next.id);
  });

  const files = diff.data?.files ?? [];
  const selectedPath = files.some((f) => f.path === picked) ? picked : files[0]?.path;
  const selectedFile = files.find((f) => f.path === selectedPath);

  if (turns.length === 0 && selection === undefined) {
    return <p className={styles.empty}>{EMPTY}</p>;
  }

  return (
    <div className={styles.tab}>
      <DiffHeader
        thread={thread}
        model={model}
        turns={turns}
        selection={selection}
        onSelect={(next) => selectTurn(thread.id, next)}
        selectedTurn={selectedTurn}
        running={running}
        prompt={firstPrompt(model, thread.id)}
        diff={diff.data}
        file={selectedFile}
        onRefresh={diff.refresh}
      />
      {diff.error ? (
        <p className={styles.error}>
          {diff.error}
          <Button variant="quiet" onClick={diff.refresh}>
            Retry
          </Button>
        </p>
      ) : null}
      {diff.data && files.length === 0 && !diff.error ? <p className={styles.empty}>{EMPTY}</p> : null}
      {files.length > 0 ? (
        <div className={styles.body}>
          <FileList
            files={files}
            selected={selectedPath}
            onSelect={setPicked}
            collapsed={collapsed}
            onToggle={toggleFileList}
          />
          <DiffPane threadId={thread.id} diff={diff.data} file={selectedFile} />
        </div>
      ) : null}
      {diff.loading && !diff.data ? <p className={styles.empty}>Loading changes…</p> : null}
    </div>
  );
}

export function ChangesTab() {
  const thread = useSelectedThread();
  if (!thread) return <p className={styles.empty}>{EMPTY}</p>;
  return <ChangesFor key={thread.id} thread={thread} />;
}
