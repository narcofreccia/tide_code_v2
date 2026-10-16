import type { Thread } from "@tide/contracts";
import { Button } from "../ui/Button.tsx";
import styles from "./EmptyThread.module.css";

/**
 * `window` event the composer listens for: `detail` is the text to put in the
 * composer (it does not send). Dispatched by the example-prompt button.
 */
export const COMPOSE_EVENT = "tide:compose";

export const EXAMPLE_PROMPT = "Explain the structure of this repo, then suggest one small cleanup.";

const EXPLAINERS: Array<{ term: string; body: string }> = [
  { term: "Agent", body: "which coding tool does the work (Claude Code, Codex, OpenCode, Pi)." },
  { term: "Model", body: "the model that agent uses; the default is whatever it picks itself." },
  { term: "Permissions", body: "how often it asks before editing files or running commands." },
  { term: "Build / Plan", body: "Build makes changes; Plan proposes a plan first and changes nothing until you approve." },
];

/** What a brand-new thread is, shown instead of an empty stream. */
export function EmptyThread({ thread }: { thread: Thread }) {
  const where =
    thread.worktreePath !== undefined && thread.branch ? (
      <>
        The agent works on branch <code>{thread.branch}</code> in its own folder, so your main checkout stays untouched.
      </>
    ) : (
      "The agent works in the project folder, directly on your current checkout."
    );
  return (
    <div className={styles.empty}>
      <h3 className={styles.title}>Start by describing the task</h3>
      <p className={styles.line}>{where}</p>
      <p className={styles.line}>Every turn is a checkpoint you can review, fork or roll back.</p>
      <dl className={styles.list} aria-label="The settings under the message box">
        {EXPLAINERS.map(({ term, body }) => (
          <div key={term} className={styles.item}>
            <dt>{term}</dt>
            <dd>{body}</dd>
          </div>
        ))}
      </dl>
      <Button
        onClick={() => window.dispatchEvent(new CustomEvent<string>(COMPOSE_EVENT, { detail: EXAMPLE_PROMPT }))}
      >
        Try: “{EXAMPLE_PROMPT}”
      </Button>
    </div>
  );
}
