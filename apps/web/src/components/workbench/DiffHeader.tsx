import { useState } from "react";
import type { DiffFile, DiffResult, MergeStrategy, ReadModel, Thread, Turn } from "@tide/contracts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Popover } from "../ui/Popover.tsx";
import { Radio } from "../ui/Choice.tsx";
import { PrBadge } from "../ui/VcsBadges.tsx";
import { PrWatch } from "./PrWatch.tsx";
import { MERGE_STRATEGIES } from "../../lib/merge.ts";
import { MergeAction } from "./MergeAction.tsx";
import { publishThread } from "../../lib/threadActions.ts";
import { ALL_CHANGES, ensureStatus, type TurnSelection } from "../../state/vcs.ts";
import { useUi } from "../../state/ui.ts";
import { openFileTab } from "../../state/workbench.ts";
import { firstChangedLine } from "../../lib/diff.ts";
import { TurnSelector } from "./TurnSelector.tsx";
import styles from "./DiffHeader.module.css";

const SETTLED: Turn["status"][] = ["completed", "error", "interrupted"];

/** Rollback / Fork for the selected turn; both open a dialog hosted by the shell. */
function TurnActions({ thread, turn, running }: { thread: Thread; turn: Turn | undefined; running: boolean }) {
  const open = (kind: "rollback" | "fork"): void => {
    if (turn) useUi.getState().setThreadDialog({ kind, threadId: thread.id, turnId: turn.id });
  };
  const noTurn = turn === undefined;
  return (
    <>
      <Button
        variant="quiet"
        disabled={noTurn || running}
        title={
          noTurn
            ? "Select a turn first"
            : running
              ? "Wait for the turn to finish"
              : "Undo this turn and everything after it"
        }
        onClick={() => open("rollback")}
      >
        Rollback…
      </Button>
      <Button
        variant="quiet"
        disabled={noTurn || !SETTLED.includes(turn.status)}
        title={noTurn ? "Select a turn first" : "Start a new thread from this point"}
        onClick={() => open("fork")}
      >
        Fork from here…
      </Button>
    </>
  );
}

/** GitHub auto-merge (`gh pr merge --auto`) once checks pass; off leaves the PR open. */
const WHEN_GREEN: { value: MergeStrategy | "off"; label: string; title: string }[] = [
  { value: "off", label: "Off", title: "Open the PR and leave it" },
  ...MERGE_STRATEGIES.map((s) => ({ value: s.value, label: s.label, title: `${s.description}, once checks pass` })),
];

/**
 * Commit / commit + push + PR. Stays available after a PR exists — follow-up turns
 * still have to reach the branch — and then updates the open PR instead of opening one.
 */
function PublishAction({
  thread,
  running,
  prompt,
  hasPr,
}: {
  thread: Thread;
  running: boolean;
  prompt: string;
  hasPr: boolean;
}) {
  const [title, setTitle] = useState(thread.title);
  const [body, setBody] = useState(prompt);
  const [whenGreen, setWhenGreen] = useState<MergeStrategy | "off">("off");
  return (
    <Popover
      label={hasPr ? "Commit & update PR" : "Commit…"}
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
          <div className={styles.field} role="radiogroup" aria-label="Merge when green">
            <span className={styles.label}>Merge when green</span>
            <div className={styles.choices}>
              {WHEN_GREEN.map((option) => (
                <Radio
                  key={option.value}
                  name={`when-green-${thread.id}`}
                  checked={whenGreen === option.value}
                  title={option.title}
                  onChange={() => setWhenGreen(option.value)}
                >
                  {option.label}
                </Radio>
              ))}
            </div>
          </div>
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
                void publishThread(thread.id, {
                  title,
                  body,
                  commitOnly: false,
                  ...(whenGreen === "off" ? {} : { mergeWhenGreen: whenGreen }),
                });
              }}
            >
              {hasPr ? "Commit + push + update PR" : "Commit + push + PR"}
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
  file,
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
  file: DiffFile | undefined;
  onRefresh: () => void;
}) {
  const sideBySide = useUi((s) => s.diffSideBySide);
  const toggle = useUi((s) => s.toggleDiffSideBySide);
  // the header claims to re-read git state, so it re-reads both halves of it
  const refresh = (): void => {
    onRefresh();
    ensureStatus(thread.id, true);
  };
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
        <Button
          variant="quiet"
          disabled={file === undefined || file.status === "deleted"}
          title={file ? `Open ${file.path} at the first change` : "Select a file first"}
          onClick={() => {
            if (!file) return;
            openFileTab(thread.id, file.path, { line: firstChangedLine(file.patch) });
          }}
        >
          Open in editor
        </Button>
        <TurnActions thread={thread} turn={selectedTurn} running={running} />
        {thread.worktreePath === undefined ? (
          <span className={styles.hint} title="Runs in the main checkout — PR needs a worktree">
            Runs in the main checkout — PR needs a worktree
          </span>
        ) : (
          <>
            {thread.pr ? (
              <>
                <PrBadge pr={thread.pr} />
                <PrWatch thread={thread} pr={thread.pr} />
              </>
            ) : null}
            <PublishAction
              thread={thread}
              running={running}
              prompt={prompt}
              hasPr={thread.pr !== undefined}
            />
          </>
        )}
        <MergeAction thread={thread} running={running} />
        <Button variant="quiet" onClick={refresh} title="Re-read the diff and git status">
          Refresh
        </Button>
      </div>
    </div>
  );
}
