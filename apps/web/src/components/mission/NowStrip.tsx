import { selectRunningThreads } from "@tide/client";
import { interruptTurn } from "../../lib/threadActions.ts";
import { PROVIDER_LABELS } from "../../lib/vocab.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { formatElapsed, useTicker } from "./useTicker.ts";
import styles from "./MissionControl.module.css";

/** The step the harness says it is on, if it reported a plan for this turn. */
function currentStep(steps: { text: string; status: string }[] | undefined): string | undefined {
  return steps?.find((s) => s.status === "in_progress")?.text;
}

/**
 * Everything with a turn in flight, longest-running first. Renders nothing when
 * nothing is running, so the page starts at the Inbox on a quiet morning.
 */
export function NowStrip({ projectId }: { projectId?: string }) {
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const running = selectRunningThreads(model, projectId);
  // one tick every 5s is enough for a seconds-resolution elapsed clock
  const now = useTicker(running.length > 0 ? 5000 : 0);
  if (running.length === 0) return null;

  return (
    <section className={styles.section} aria-label="Now">
      <h2 className={styles.label}>Now</h2>
      <ul className={styles.list}>
        {running.map(({ thread, startedAt }) => {
          const step = currentStep(thread.planProgress?.steps);
          return (
            <li key={thread.id} className={styles.nowRow}>
              <button type="button" className={styles.rowButton} onClick={() => selectThread(thread.id)}>
                <StatusGlyph
                  status={thread.status}
                  {...(thread.interrupting === true ? { interrupting: true } : {})}
                />
                <span className={styles.title}>{thread.title}</span>
                <span className={styles.meta}>
                  {model.projects[thread.projectId]?.title ?? "—"} · {PROVIDER_LABELS[thread.provider]}
                  {thread.model ? ` · ${thread.model}` : ""}
                </span>
              </button>
              <span className={styles.step}>{step ?? ""}</span>
              <span className={styles.elapsed} aria-label={`elapsed ${formatElapsed(now - startedAt)}`}>
                {formatElapsed(now - startedAt)}
              </span>
              <Button
                variant="quiet"
                disabled={thread.interrupting === true}
                aria-label={`Stop ${thread.title}`}
                onClick={() => interruptTurn(thread.id)}
              >
                Stop
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
