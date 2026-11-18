import { useState } from "react";
import { limitedView, selectLimited, selectSnoozed } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { dispatchOrToast } from "../../lib/dispatchOrToast.ts";
import { continueBlock, resumeThread, setLimitPolicy } from "../../lib/turnActions.ts";
import { limitedText, threadHarnessLabel } from "../../lib/vocab.ts";
import { useProvidersSnapshot } from "../../state/providers.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Pill } from "../ui/Pill.tsx";
import { useTicker } from "./useTicker.ts";
import mc from "./MissionControl.module.css";
import styles from "./Limited.module.css";

/** Continue a limited thread whose window reopened (`thread.resume` with continue). */
function ContinueButton({ thread, label = "Continue" }: { thread: Thread; label?: string }) {
  const blocked = continueBlock(thread);
  return (
    <Button
      variant="quiet"
      disabled={blocked !== undefined}
      title={blocked}
      onClick={() => resumeThread(thread.id, true)}
    >
      {label}
    </Button>
  );
}

/** The inbox card of a limited thread that waits for the user: the window reopened. */
export function LimitReadyCard({ thread }: { thread: Thread }) {
  return (
    <li className={styles.row}>
      <span className={styles.title}>Limit reset, continue?</span>
      <span className={styles.meta} title={thread.limited?.note}>
        {thread.limited?.note ?? "The harness's usage window reopened"}
      </span>
      <div className={styles.actions}>
        <ContinueButton thread={thread} />
      </div>
    </li>
  );
}

/** Threads parked on a usage limit. Hidden entirely when there are none. */
export function LimitedSection() {
  const providers = useProvidersSnapshot();
  const model = useModel((s) => s.model);
  const selectThread = useUi((s) => s.selectThread);
  const limited = selectLimited(model);
  // the reset passing is no event: tick so a waiting row turns into Continue
  useTicker(limited.length > 0 ? 30_000 : 0);
  const now = Date.now();
  if (limited.length === 0) return null;

  return (
    <section className={mc.section} aria-label="Limited">
      <h2 className={mc.label}>Limited · {limited.length}</h2>
      <ul className={mc.list}>
        {limited.map((thread) => {
          const lim = thread.limited;
          const view = limitedView(model, thread, now);
          if (!lim || !view) return null;
          return (
            <li key={thread.id} className={styles.row}>
              <button type="button" className={`${mc.rowButton}`} onClick={() => selectThread(thread.id)}>
                <span className={styles.title}>{thread.title}</span>
              </button>
              <Pill>{threadHarnessLabel(providers, thread)}</Pill>
              <span className={styles.meta} title={lim.note}>
                {limitedText(view, now)}
                {lim.resume === "reset" && view.phase !== "ready" ? " · auto" : ""}
              </span>
              <div className={styles.actions}>
                <ContinueButton thread={thread} label={view.needsUser ? "Continue" : "Resume now"} />
                <Button
                  variant="quiet"
                  disabled={lim.resume === "reset"}
                  onClick={() => setLimitPolicy(thread.id, "reset")}
                >
                  At reset
                </Button>
                <Button
                  variant="quiet"
                  disabled={lim.resume === "manual"}
                  onClick={() => setLimitPolicy(thread.id, "manual")}
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
          <Icon name="chevronRight" size={12} className={`${open ? mc.chevronOpen : mc.chevron}`} />
          Snoozed · {snoozed.length}
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
