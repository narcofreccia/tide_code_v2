import { isSnoozed, selectBackgroundAgentsCore, selectRunningThreads } from "@tide/client";
import type { ReadModel, Thread } from "@tide/contracts";
import { interruptTurn } from "../../lib/threadActions.ts";
import { backgroundAgentsText, threadHarnessLabel } from "../../lib/vocab.ts";
import { useProvidersSnapshot } from "../../state/providers.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { StatusGlyph, ThreadGlyph } from "../ui/StatusGlyph.tsx";
import { formatElapsed, useTicker } from "./useTicker.ts";
import styles from "./MissionControl.module.css";

/** The step the harness says it is on, if it reported a plan for this turn. */
function currentStep(steps: { text: string; status: string }[] | undefined): string | undefined {
  return steps?.find((s) => s.status === "in_progress")?.text;
}

interface BackgroundRow {
  thread: Thread;
  agents: number;
  /** when the oldest background agent started */
  since: number;
}

/** Threads between turns whose sub-agents still work: listed after the running ones, no Stop. */
export function backgroundRows(model: ReadModel, projectId: string | undefined, now: number): BackgroundRow[] {
  const out: BackgroundRow[] = [];
  for (const thread of Object.values(model.threads)) {
    if (thread.status === "running" || thread.archivedAt !== undefined || isSnoozed(thread, now)) continue;
    if (projectId !== undefined && thread.projectId !== projectId) continue;
    const agents = selectBackgroundAgentsCore(model, thread.id);
    if (agents.length === 0) continue;
    out.push({ thread, agents: agents.length, since: Math.min(...agents.map((a) => a.startedAt)) });
  }
  return out.sort((a, b) => a.since - b.since || a.thread.id.localeCompare(b.thread.id));
}

/**
 * Everything with a turn in flight, longest-running first, then threads whose turn ended
 * while sub-agents still work. Renders nothing when nothing is running, so a quiet morning shows only the Needs-you line.
 */
export function NowStrip({ projectId }: { projectId?: string }) {
  const providers = useProvidersSnapshot();
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const running = selectRunningThreads(model, projectId);
  const background = backgroundRows(model, projectId, Date.now());
  // one tick every 5s is enough for a seconds-resolution elapsed clock
  const now = useTicker(running.length + background.length > 0 ? 5000 : 0);
  if (running.length === 0 && background.length === 0) return null;

  return (
    <section className={styles.section} aria-label="Now">
      <h2 className={styles.label}>Running now</h2>
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
                  {model.projects[thread.projectId]?.title ?? "—"} · {threadHarnessLabel(providers, thread)}
                  {thread.model ? ` · ${thread.model}` : ""}
                </span>
              </button>
              <span className={styles.step}>{step ?? ""}</span>
              <span className={styles.elapsed} aria-label={`elapsed ${formatElapsed(now - startedAt)}`}>
                {formatElapsed(now - startedAt)}
              </span>
              <Button
                variant="quietDanger"
                disabled={thread.interrupting === true}
                aria-label={`Stop ${thread.title}`}
                onClick={() => interruptTurn(thread.id)}
              >
                Stop
              </Button>
            </li>
          );
        })}
        {background.map(({ thread, agents, since }) => (
          <li key={thread.id} className={styles.nowRow}>
            <button type="button" className={styles.rowButton} onClick={() => selectThread(thread.id)}>
              <ThreadGlyph thread={thread} />
              <span className={styles.title}>{thread.title}</span>
              <span className={styles.meta}>
                {model.projects[thread.projectId]?.title ?? "—"} · {threadHarnessLabel(providers, thread)}
              </span>
            </button>
            <span className={styles.step}>{backgroundAgentsText(agents)}</span>
            <span className={styles.elapsed} aria-label={`elapsed ${formatElapsed(now - since)}`}>
              {formatElapsed(now - since)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
