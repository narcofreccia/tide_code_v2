import type { Thread } from "@tide/contracts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { COMPOSE_EVENT, compose } from "../../lib/cite.ts";
import styles from "./EmptyThread.module.css";

/**
 * `window` event the composer listens for (see `lib/cite.ts`): `detail` is a string
 * (replace) or `{ text, mode: "replace" | "append" }`. It never sends.
 */
export { COMPOSE_EVENT };

export const EXAMPLE_PROMPT = "Explain the structure of this repo, then suggest one small cleanup.";

const EXPLAINERS: Array<{ term: string; body: string }> = [
  { term: "Agent", body: "which coding tool does the work (Claude Code, Codex, OpenCode, Pi)." },
  { term: "Model", body: "the model that agent uses; the default is whatever it picks itself." },
  { term: "Permissions", body: "how often it asks before editing files or running commands." },
  { term: "Build / Plan", body: "Build makes changes; Plan proposes a plan first and changes nothing until you approve." },
];

/** What a brand-new thread is, shown instead of an empty stream. */
export function EmptyThread({ thread }: { thread: Thread }) {
  const openNewThread = useUi((s) => s.openNewThread);
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
      <p className={styles.line}>
        One thread has one agent. To have several work together (one plans, another builds, a third reviews), start a{" "}
        <Button variant="link" onClick={() => openNewThread({ projectId: thread.projectId, tab: "team" })}>
          Team run
        </Button>{" "}
        instead.
      </p>
      <Button
        onClick={() => compose(EXAMPLE_PROMPT)}
      >
        Try: “{EXAMPLE_PROMPT}”
      </Button>
    </div>
  );
}
