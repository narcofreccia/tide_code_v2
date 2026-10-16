import { StateGlyph } from "../ui/StatusGlyph.tsx";
import { Popover } from "../ui/Popover.tsx";
import { THREAD_STATE_WORDS, type ThreadStateKey } from "../../lib/vocab.ts";
import styles from "./StatusLegend.module.css";

export const LEGEND: Array<{ state: ThreadStateKey; meaning: string }> = [
  { state: "idle", meaning: "Waiting for your next message" },
  { state: "running", meaning: "The agent is working" },
  { state: "needs", meaning: "Waiting on you: an approval, a question or a plan" },
  { state: "error", meaning: "The last turn failed" },
  { state: "interrupted", meaning: "You stopped the last turn" },
  { state: "limited", meaning: "The subscription window is used up; resumes at reset" },
  { state: "snoozed", meaning: "Hidden from Inbox until the snooze ends" },
  { state: "merged", meaning: "The branch landed on its base" },
];

/** The glyph table on its own, for embedding. */
export function StatusLegendTable() {
  return (
    <table className={styles.table} aria-label="Status legend">
      <tbody>
        {LEGEND.map(({ state, meaning }) => (
          <tr key={state}>
            <td className={styles.glyph}>
              <StateGlyph state={state} />
            </td>
            <th scope="row" className={styles.word}>
              {THREAD_STATE_WORDS[state]}
            </th>
            <td className={styles.meaning}>{meaning}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A "?" button that opens the legend; mount it in the rail footer. */
export function StatusLegend() {
  return (
    <Popover label="?" title="What do the status symbols mean?" variant="quiet" align="start">
      {() => <StatusLegendTable />}
    </Popover>
  );
}
