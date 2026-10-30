import { useState } from "react";
import type { ProviderKind, ScheduledTask, Thread } from "@tide/contracts";
import { WEEKDAY_ORDER, weekdayName } from "../../lib/schedule.ts";
import type { TaskFields } from "../../lib/taskActions.ts";
import { HarnessFields } from "../thread/ProviderPicker.tsx";
import { Button } from "../ui/Button.tsx";
import { Checkbox, Radio } from "../ui/Choice.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Select } from "../ui/Select.tsx";
import styles from "./Automations.module.css";
import section from "./Section.module.css";

type Unit = "minutes" | "hours";
const UNITS = [
  { value: "minutes" as const, label: "minutes" },
  { value: "hours" as const, label: "hours" },
];
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

interface Draft {
  title: string;
  prompt: string;
  kind: "interval" | "fixed" | "webhook";
  /** webhook: the id in POST /hook/<hookId>; generated once per draft */
  hookId: string;
  amount: string;
  unit: Unit;
  times: string[];
  timeInput: string;
  weekdays: number[];
  target: "new" | "thread";
  provider: ProviderKind;
  model: string;
  threadId: string;
  useWorktree: boolean;
  enabled: boolean;
}

function randomHookId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function initial(task: ScheduledTask | undefined): Draft {
  const s = task?.schedule;
  const everyMin = s?.kind === "interval" ? Math.round(s.everyMs / 60_000) : 30;
  const hours = everyMin >= 60 && everyMin % 60 === 0;
  return {
    title: task?.title ?? "",
    prompt: task?.prompt ?? "",
    kind: s?.kind ?? "interval",
    hookId: s?.kind === "webhook" ? s.hookId : randomHookId(),
    amount: String(hours ? everyMin / 60 : everyMin),
    unit: hours ? "hours" : "minutes",
    times: s?.kind === "fixed" ? [...s.times] : [],
    timeInput: "09:00",
    weekdays: s?.kind === "fixed" ? [...s.weekdays] : [1, 2, 3, 4, 5],
    target: task?.threadId === undefined ? "new" : "thread",
    provider: task?.provider ?? "claude",
    model: task?.model ?? "",
    threadId: task?.threadId ?? "",
    useWorktree: task?.useWorktree ?? true,
    enabled: task?.enabled ?? true,
  };
}

/** Returns the first problem with the draft, or the fields to send. */
export function validateDraft(d: Draft): { error: string } | { fields: TaskFields } {
  if (d.title.trim() === "") return { error: "Give the automation a title." };
  if (d.prompt.trim() === "") return { error: "Write the prompt to send." };
  const amount = Number(d.amount);
  const everyMs = amount * (d.unit === "hours" ? 3_600_000 : 60_000);
  if (d.kind === "interval" && (!Number.isFinite(amount) || everyMs < 60_000)) return { error: "The interval must be at least 1 minute." };
  if (d.kind === "fixed" && d.times.length === 0) return { error: "Add at least one time." };
  if (d.kind === "fixed" && d.weekdays.length === 0) return { error: "Pick at least one weekday." };
  if (d.target === "thread" && d.threadId === "") return { error: "Pick the thread to send into." };
  return {
    fields: {
      title: d.title.trim(),
      prompt: d.prompt.trim(),
      schedule:
        d.kind === "interval" ? { kind: "interval", everyMs: Math.round(everyMs) }
        : d.kind === "webhook" ? { kind: "webhook", hookId: d.hookId }
        : { kind: "fixed", times: [...d.times].sort(), weekdays: d.weekdays },
      enabled: d.enabled,
      ...(d.target === "thread"
        ? { threadId: d.threadId }
        : { provider: d.provider, ...(d.model === "" ? {} : { model: d.model }), useWorktree: d.useWorktree }),
    },
  };
}

/** Create / edit form for one automation. */
export function TaskDialog({
  task,
  threads,
  onSubmit,
  onCancel,
}: {
  task?: ScheduledTask;
  threads: Thread[];
  onSubmit: (fields: TaskFields) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(() => initial(task));
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<Draft>): void => setD((prev) => ({ ...prev, ...patch }));

  const addTime = (): void => {
    if (!TIME.test(d.timeInput)) return setError("Times look like 09:00.");
    setError(null);
    if (!d.times.includes(d.timeInput)) set({ times: [...d.times, d.timeInput].sort() });
  };
  const toggleDay = (day: number): void =>
    set({ weekdays: d.weekdays.includes(day) ? d.weekdays.filter((x) => x !== day) : [...d.weekdays, day] });

  const submit = (): void => {
    const result = validateDraft(d);
    if ("error" in result) return setError(result.error);
    onSubmit(result.fields);
  };

  return (
    <Dialog title={task ? "Edit automation" : "New automation"} onCancel={onCancel}>
      <div className={styles.dialog}>
        <label className={styles.field}>
          <span className={styles.label}>Title</span>
          <input className={styles.input} aria-label="Title" value={d.title} onChange={(e) => set({ title: e.target.value })} />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Prompt</span>
          <textarea className={styles.text} aria-label="Prompt" value={d.prompt} onChange={(e) => set({ prompt: e.target.value })} />
        </label>

        <fieldset className={styles.field}>
          <span className={styles.label}>Schedule</span>
          <div className={styles.row}>
            <Radio name="kind" checked={d.kind === "interval"} onChange={() => set({ kind: "interval" })}>Every</Radio>
            <Radio name="kind" checked={d.kind === "fixed"} onChange={() => set({ kind: "fixed" })}>At fixed times</Radio>
            <Radio name="kind" checked={d.kind === "webhook"} onChange={() => set({ kind: "webhook" })}>On a webhook</Radio>
          </div>
          {d.kind === "interval" ? (
            <div className={styles.row}>
              <input className={`${styles.input} ${styles.num}`} type="number" min={1} aria-label="Interval" value={d.amount} onChange={(e) => set({ amount: e.target.value })} />
              <Select label="Interval unit" value={d.unit} options={UNITS} onSelect={(unit) => set({ unit })} variant="field" size="md" />
            </div>
          ) : d.kind === "webhook" ? (
            <p className={section.note}>
              Fires on <code>POST /hook/{d.hookId}</code> on this environment (or through the relay). The request body is
              appended to the prompt. Sign requests with <code>X-Tide-Signature</code> if you set a secret in Automations.
            </p>
          ) : (
            <>
              <div className={styles.row}>
                {d.times.map((t) => (
                  <span key={t} className={styles.chip}>
                    {t}
                    <Button variant="quiet" aria-label={`Remove ${t}`} onClick={() => set({ times: d.times.filter((x) => x !== t) })}>×</Button>
                  </span>
                ))}
                <input className={`${styles.input} ${styles.num}`} aria-label="Time" value={d.timeInput} onChange={(e) => set({ timeInput: e.target.value })} />
                <Button onClick={addTime}>Add time</Button>
              </div>
              <div className={styles.row}>
                {WEEKDAY_ORDER.map((day) => (
                  <Button
                    key={day}
                    variant="quiet"
                    aria-pressed={d.weekdays.includes(day)}
                    className={d.weekdays.includes(day) ? styles.dayOn : ""}
                    onClick={() => toggleDay(day)}
                  >
                    {weekdayName(day)}
                  </Button>
                ))}
              </div>
            </>
          )}
        </fieldset>

        <fieldset className={styles.field}>
          <span className={styles.label}>Target</span>
          <div className={styles.row}>
            <Radio name="target" checked={d.target === "new"} onChange={() => set({ target: "new" })}>A new thread each run</Radio>
            <Radio name="target" checked={d.target === "thread"} onChange={() => set({ target: "thread" })}>An existing thread</Radio>
          </div>
          {d.target === "new" ? (
            <>
              <HarnessFields name="Automation" provider={d.provider} model={d.model} onChange={(patch) => set({ ...(patch.provider === undefined ? {} : { provider: patch.provider }), ...(patch.model === undefined ? {} : { model: patch.model }) })} />
              <Checkbox checked={d.useWorktree} onChange={(e) => set({ useWorktree: e.target.checked })}>Use a worktree</Checkbox>
            </>
          ) : (
            <Select
              label="Thread"
              value={d.threadId}
              options={threads.map((t) => ({ value: t.id, label: t.title }))}
              onSelect={(threadId) => set({ threadId })}
              placeholder="Pick a thread"
              variant="field"
              size="md"
              searchable
            />
          )}
        </fieldset>

        <Checkbox checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })}>Enabled</Checkbox>
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
      </div>
      <div className={styles.footer}>
        <Button variant="quiet" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" onClick={submit}>{task ? "Save" : "Create"}</Button>
      </div>
    </Dialog>
  );
}
