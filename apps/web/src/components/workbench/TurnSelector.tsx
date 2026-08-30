import type { ReadModel, Turn } from "@tide/contracts";
import { selectTurnPrompt } from "@tide/client";
import { Popover } from "../ui/Popover.tsx";
import { ALL_CHANGES, type TurnSelection } from "../../state/vcs.ts";
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

export function TurnSelector({
  model,
  threadId,
  turns,
  selection,
  onSelect,
}: {
  model: ReadModel;
  threadId: string;
  /** turns that recorded a checkpoint, oldest first */
  turns: Turn[];
  selection: TurnSelection | undefined;
  onSelect: (selection: TurnSelection) => void;
}) {
  const index = turns.findIndex((t) => t.id === selection);
  const label =
    selection === ALL_CHANGES || index === -1
      ? selection === ALL_CHANGES
        ? "All changes"
        : "Current turn"
      : `Turn ${index + 1} of ${turns.length}`;

  return (
    <Popover label={`${label} ▾`} title="Choose which turn to diff" variant="quiet">
      {(close) => (
        <ul className={styles.menu} role="listbox" aria-label="Turns">
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
        </ul>
      )}
    </Popover>
  );
}
