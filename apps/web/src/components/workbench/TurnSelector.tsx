import { useState } from "react";
import type { CommitSummary, ReadModel, Turn } from "@tide/contracts";
import { selectTurnPrompt } from "@tide/client";
import { Icon } from "../ui/Icon.tsx";
import { Popover } from "../ui/Popover.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Radio } from "../ui/Choice.tsx";
import { relativeTime } from "../../lib/relativeTime.ts";
import { ALL_CHANGES, commitSelection, commitSha, isCommitSelection, type TurnSelection } from "../../state/vcs.ts";
import styles from "./TurnSelector.module.css";

const LABEL_LIMIT = 40;

/** First line of the prompt that opened the turn, trimmed to 40 chars. */
export function turnLabel(model: ReadModel, threadId: string, turn: Turn): string {
  const prompt = selectTurnPrompt(model, threadId, turn.id)?.replace(/\s+/g, " ").trim();
  if (!prompt) return "(no prompt)";
  return prompt.length > LABEL_LIMIT ? `${prompt.slice(0, LABEL_LIMIT)}…` : prompt;
}

function Stats({ turn }: { turn: Turn }) {
  const stats = turn.checkpoint?.stats;
  if (!stats) return null;
  return (
    <span className={styles.stats}>
      <span className={styles.add}>+{stats.additions}</span>{" "}
      <span className={styles.del}>−{stats.deletions}</span>
    </span>
  );
}

type Source = "turns" | "commits";

function CommitRows({
  commits,
  selection,
  onPick,
}: {
  commits: CommitSummary[];
  selection: TurnSelection | undefined;
  onPick: (sha: string) => void;
}) {
  if (commits.length === 0) return <li className={styles.empty}>No commits on this branch</li>;
  return (
    <>
      {commits.map((commit) => {
        const selected = selection === commitSelection(commit.sha);
        return (
          <li key={commit.sha}>
            <button
              type="button"
              role="option"
              aria-selected={selected}
              className={`${styles.item} ${selected ? styles.active : ""}`}
              onClick={() => onPick(commit.sha)}
            >
              <span className={styles.index}>{commit.shortSha}</span>
              <span className={styles.text} title={commit.subject}>
                {commit.subject}
              </span>
              {commit.parents.length > 1 ? <Pill size="sm">merge</Pill> : null}
              <span className={styles.index} title={new Date(commit.at).toLocaleString()}>
                {relativeTime(commit.at)}
              </span>
            </button>
          </li>
        );
      })}
    </>
  );
}

export function TurnSelector({
  model,
  threadId,
  turns,
  selection,
  onSelect,
  commits,
}: {
  model: ReadModel;
  threadId: string;
  /** turns that recorded a checkpoint, oldest first */
  turns: Turn[];
  selection: TurnSelection | undefined;
  onSelect: (selection: TurnSelection) => void;
  /** the branch's newest commits; omit to offer turns only */
  commits?: CommitSummary[] | undefined;
}) {
  const [source, setSource] = useState<Source>(isCommitSelection(selection) ? "commits" : "turns");
  const index = turns.findIndex((t) => t.id === selection);
  const sha = selection === undefined ? undefined : commitSha(selection);
  const label =
    sha !== undefined
      ? `Commit ${sha.slice(0, 7)}`
      : selection === ALL_CHANGES
        ? "All changes"
        : index === -1
          ? "Current turn"
          : `Turn ${index + 1} of ${turns.length}`;

  return (
    <Popover
      label={
        <>
          <span>{label}</span>
          <Icon name="chevronDown" size={12} />
        </>
      }
      title="Choose which turn or commit to diff" variant="quiet">
      {(close) => (
        <>
          {commits === undefined ? null : (
            <div className={styles.segment} role="radiogroup" aria-label="Diff source">
              <Radio name={`diff-source-${threadId}`} checked={source === "turns"} onChange={() => setSource("turns")}>
                Turns
              </Radio>
              <Radio name={`diff-source-${threadId}`} checked={source === "commits"} onChange={() => setSource("commits")}>
                Commits
              </Radio>
            </div>
          )}
          <ul className={styles.menu} role="listbox" aria-label={source === "commits" ? "Commits" : "Turns"}>
            {source === "commits" && commits !== undefined ? (
              <CommitRows
                commits={commits}
                selection={selection}
                onPick={(picked) => {
                  onSelect(commitSelection(picked));
                  close();
                }}
              />
            ) : (
              <>
                {turns.map((turn, i) => (
                  <li key={turn.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={turn.id === selection}
                      className={`${styles.item} ${turn.id === selection ? styles.active : ""}`}
                      onClick={() => {
                        onSelect(turn.id);
                        close();
                      }}
                    >
                      <span className={styles.index}>Turn {i + 1}</span>
                      <span className={styles.text}>{turnLabel(model, threadId, turn)}</span>
                      <Stats turn={turn} />
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={selection === ALL_CHANGES}
                    className={`${styles.item} ${selection === ALL_CHANGES ? styles.active : ""}`}
                    onClick={() => {
                      onSelect(ALL_CHANGES);
                      close();
                    }}
                  >
                    <span className={styles.text}>All changes</span>
                  </button>
                </li>
              </>
            )}
          </ul>
        </>
      )}
    </Popover>
  );
}
