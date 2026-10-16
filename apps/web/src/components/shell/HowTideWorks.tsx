import { useEffect, useState } from "react";
import type { ReadModel } from "@tide/contracts";
import { Button } from "../ui/Button.tsx";
import styles from "./HowTideWorks.module.css";

export const HOW_IT_WORKS_KEY = "tide.howItWorks.dismissed";
/** Fired on `window` to bring the card back (⌘K › How Tide works). */
export const HOW_IT_WORKS_EVENT = "tide:how-it-works";

const POINTS: Array<{ title: string; body: string }> = [
  { title: "Threads are branches", body: "Each thread works in its own folder on its own git branch, so threads never step on each other." },
  { title: "Steer or queue", body: "Send a message while the agent runs to steer it now, or queue it for after the turn." },
  { title: "Checkpoints", body: "Every turn is a checkpoint. Fork or roll back from any turn, on any agent." },
  { title: "Merge back or open a PR", body: "When the work is good, merge the branch into its base or open a pull request." },
];

function dismissed(): boolean {
  try {
    return window.localStorage.getItem(HOW_IT_WORKS_KEY) === "1";
  } catch {
    return false;
  }
}

/** Show the card after the first project exists, until dismissed. */
export function shouldShowHowItWorks(model: ReadModel): boolean {
  return Object.keys(model.projects).length > 0 && !dismissed();
}

/** Brings the card back after a dismissal (used by the palette entry). */
export function showHowTideWorks(): void {
  try {
    window.localStorage.removeItem(HOW_IT_WORKS_KEY);
  } catch {
    /* storage unavailable: the card simply reappears via the event */
  }
  window.dispatchEvent(new Event(HOW_IT_WORKS_EVENT));
}

/** Dismissible four-point explainer for Mission Control. Hidden state is remembered in localStorage. */
export function HowTideWorks({ forceVisible = false }: { forceVisible?: boolean }) {
  const [hidden, setHidden] = useState(dismissed);
  useEffect(() => {
    const onShow = (): void => setHidden(false);
    window.addEventListener(HOW_IT_WORKS_EVENT, onShow);
    return () => window.removeEventListener(HOW_IT_WORKS_EVENT, onShow);
  }, []);
  if (hidden && !forceVisible) return null;

  return (
    <section className={styles.card} aria-label="How Tide works">
      <div className={styles.head}>
        <h3 className={styles.title}>How Tide works</h3>
        <Button
          variant="quiet"
          aria-label="Dismiss how Tide works"
          onClick={() => {
            try {
              window.localStorage.setItem(HOW_IT_WORKS_KEY, "1");
            } catch {
              /* remembered for this session only */
            }
            setHidden(true);
          }}
        >
          ✕
        </Button>
      </div>
      <ol className={styles.points}>
        {POINTS.map((p) => (
          <li key={p.title}>
            <strong>{p.title}.</strong> <span className={styles.body}>{p.body}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
