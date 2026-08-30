import { useState } from "react";
import type { DiffResult, ReadModel, Thread, Turn } from "@tide/contracts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Popover } from "../ui/Popover.tsx";
import { PrBadge } from "../ui/VcsBadges.tsx";
import { publishThread, revertTurn } from "../../lib/threadActions.ts";
import { ALL_CHANGES, type TurnSelection } from "../../state/vcs.ts";
import { useUi } from "../../state/ui.ts";
import { TurnSelector } from "./TurnSelector.tsx";
import styles from "./DiffHeader.module.css";

function RevertAction({ thread, turn, running }: { thread: Thread; turn: Turn | undefined; running: boolean }) {
  const disabled = running || turn?.checkpoint?.before === undefined;
  const title = running
    ? "Wait for the turn to finish"
    : turn?.checkpoint?.before === undefined
      ? "This turn has no checkpoint to revert to"
      : "Restore the worktree to the state before this turn";
  return (
    <Popover label="Revert this turn" title={title} variant="quiet" disabled={disabled} align="end">
      {(close) => (
        <div className={styles.confirm}>
          <p className={styles.confirmText}>
            Discard everything this turn changed in <strong>{thread.branch ?? "the worktree"}</strong>? This
            cannot be undone.
          </p>
          <div className={styles.confirmRow}>
            <Button variant="quiet" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                close();
                if (turn) void revertTurn(thread.id, turn.id);
              }}
            >
              Revert
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

function PublishAction({ thread, running, prompt }: { thread: Thread; running: boolean; prompt: string }) {
  const [title, setTitle] = useState(thread.title);
  const [body, setBody] = useState(prompt);
  return (
    <Popover
      label="Commit…"
      title={running ? "Wait for the turn to finish" : "Commit, or commit + push + PR"}
      variant="quiet"
      disabled={running}
      align="end"
    >
      {(close) => (
        <div className={styles.publish}>
          <label className={styles.field}>
            <span className={styles.label}>Title</span>
            <input
              className={styles.input}
              aria-label="Commit title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span className={styles.label}>Body</span>
            <textarea
              className={styles.textarea}
              aria-label="Commit body"
              rows={4}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <div className={styles.confirmRow}>
            <Button
              variant="quiet"
              onClick={() => {
                close();
                void publishThread(thread.id, { title, body, commitOnly: true });
              }}
            >
              Commit
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                close();
                void publishThread(thread.id, { title, body, commitOnly: false });
              }}
            >
              Commit + push + PR
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

/** Top row of the Changes tab: which turn, how to render it, what to do with it. */
export function DiffHeader({
  thread,
  model,
  turns,
  selection,
  onSelect,
  selectedTurn,
  running,
  prompt,
  diff,
  onRefresh,
}: {
  thread: Thread;
  model: ReadModel;
  turns: Turn[];
  selection: TurnSelection | undefined;
  onSelect: (selection: TurnSelection) => void;
  selectedTurn: Turn | undefined;
  running: boolean;
  prompt: string;
  diff: DiffResult | undefined;
  onRefresh: () => void;
}) {
  const sideBySide = useUi((s) => s.diffSideBySide);
  const toggle = useUi((s) => s.toggleDiffSideBySide);
  const total = (diff?.files ?? []).reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 },
  );

  return (
    <div className={styles.header}>
      <TurnSelector
        model={model}
        threadId={thread.id}
        turns={turns}
        selection={selection}
        onSelect={onSelect}
      />
      {diff ? (
        <span className={styles.stats}>
          <span className={styles.add}>+{total.additions}</span>{" "}
          <span className={styles.del}>−{total.deletions}</span>
        </span>
      ) : null}
      {selection === ALL_CHANGES ? <span className={styles.hint}>whole thread</span> : null}

      <div className={styles.actions}>
        <Button
          variant="quiet"
          onClick={toggle}
          aria-pressed={sideBySide}
          title="Toggle unified / side-by-side (⌘⇧D)"
        >
          {sideBySide ? "Split" : "Unified"} <Kbd>⌘⇧D</Kbd>
        </Button>
        <Button variant="quiet" disabled title="P3">
          Open in editor
        </Button>
        <RevertAction thread={thread} turn={selectedTurn} running={running} />
        {thread.pr ? (
          <>
            <PrBadge pr={thread.pr} />
            <Button variant="quiet" onClick={onRefresh} title="Re-read git status">
              Refresh
            </Button>
          </>
        ) : (
          <PublishAction thread={thread} running={running} prompt={prompt} />
        )}
      </div>
    </div>
  );
}
