import { useState } from "react";
import { selectLimited, selectSnoozed } from "@tide/client";
import { dispatchOrToast } from "../../lib/dispatchOrToast.ts";
import { relativeUntil } from "../../lib/relativeTime.ts";
import { threadHarnessLabel } from "../../lib/vocab.ts";
import { useProvidersSnapshot } from "../../state/providers.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { useTicker } from "./useTicker.ts";
import mc from "./MissionControl.module.css";
import styles from "./Limited.module.css";

/** Threads parked on a usage limit. Hidden entirely when there are none. */
export function LimitedSection() {
  const providers = useProvidersSnapshot();
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const limited = selectLimited(model);
  const now = useTicker(limited.length > 0 ? 30_000 : 0);
  if (limited.length === 0) return null;

  return (
    <section className={mc.section} aria-label="Limited">
      <h2 className={mc.label}>Limited · {limited.length}</h2>
      <ul className={mc.list}>
        {limited.map((thread) => {
          const lim = thread.limited;
          if (!lim) return null;
          return (
            <li key={thread.id} className={styles.row}>
              <button type="button" className={`${mc.rowButton}`} onClick={() => selectThread(thread.id)}>
                <span className={styles.title}>{thread.title}</span>
              </button>
              <Pill>{threadHarnessLabel(providers, thread)}</Pill>
              <span className={styles.meta} title={lim.note}>
                {lim.resetsAt === undefined ? "reset unknown" : `resets ${relativeUntil(lim.resetsAt, now)}`}
                {lim.resume === "reset" ? " · auto" : ""}
              </span>
              <div className={styles.actions}>
                <Button
                  variant="quiet"
                  onClick={() =>
                    dispatchOrToast("Resuming the thread", { type: "thread.resume", threadId: thread.id, continue: true })
                  }
                >
                  Resume now
                </Button>
                <Button
                  variant="quiet"
                  disabled={lim.resume === "reset"}
                  onClick={() =>
                    dispatchOrToast("Setting the limit policy", {
                      type: "thread.limit-policy",
                      threadId: thread.id,
                      resume: "reset",
                    })
                  }
                >
                  At reset
                </Button>
                <Button
                  variant="quiet"
                  disabled={lim.resume === "manual"}
                  onClick={() =>
                    dispatchOrToast("Setting the limit policy", {
                      type: "thread.limit-policy",
                      threadId: thread.id,
                      resume: "manual",
                    })
                  }
                >
                  Wait
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Collapsed list of snoozed threads with an Unsnooze action. */
export function SnoozedSection() {
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const [open, setOpen] = useState(false);
  const now = useTicker(30_000);
  const snoozed = selectSnoozed(model, now);
  if (snoozed.length === 0) return null;

  return (
    <section className={mc.section} aria-label="Snoozed">
      <h2 className={mc.label}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "▾" : "▸"} Snoozed · {snoozed.length}
        </button>
      </h2>
      {open ? (
        <ul className={mc.list}>
          {snoozed.map((thread) => (
            <li key={thread.id} className={styles.row}>
              <button type="button" className={mc.rowButton} onClick={() => selectThread(thread.id)}>
                <span className={styles.title}>{thread.title}</span>
              </button>
              <span className={styles.meta}>
                until {new Date(thread.snoozedUntil ?? 0).toLocaleString([], { hour: "2-digit", minute: "2-digit", month: "short", day: "numeric" })}
              </span>
              <Button
                variant="quiet"
                onClick={() => dispatchOrToast("Unsnoozing the thread", { type: "thread.resume", threadId: thread.id })}
              >
                Unsnooze
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
