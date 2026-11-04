import { useState } from "react";
import type { ProviderKind, ScheduledTask, Thread } from "@tide/contracts";
import { WEEKDAY_ORDER, weekdayName } from "../../lib/schedule.ts";
import type { TaskFields } from "../../lib/taskActions.ts";
import { HarnessFields } from "../thread/ProviderPicker.tsx";
import { Button } from "../ui/Button.tsx";
import { Checkbox, Radio } from "../ui/Choice.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Select } from "../ui/Select.tsx";
import { WebhookUrls } from "../fleet/WebhookUrls.tsx";
import styles from "./Automations.module.css";

type Unit = "minutes" | "hours";
const UNITS = [
  { value: "minutes" as const, label: "minutes" },
  { value: "hours" as const, label: "hours" },
];
const TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

interface Draft {
  title: string;
  prompt: string;
  kind: "interval" | "fixed" | "once" | "webhook";
  /** webhook: the id in POST /hook/<hookId>; generated once per draft */
  hookId: string;
  /** webhook: optional HMAC secret; "" sends none */
  secret: string;
  amount: string;
  unit: Unit;
  times: string[];
  timeInput: string;
  weekdays: number[];
  /** once: `datetime-local` value, local time ("2026-11-06T14:30") */
  onceAt: string;
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

const pad = (n: number): string => String(n).padStart(2, "0");

/** ms epoch → the `datetime-local` input's value, in local time. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `datetime-local` value (local time) → ms epoch; NaN when empty or malformed. */
export function fromLocalInput(value: string): number {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ? new Date(value).getTime() : Number.NaN;
}

/** The next full hour, a sensible default for "once". */
const nextHour = (now: number): number => Math.floor(now / 3_600_000) * 3_600_000 + 3_600_000;

function initial(task: ScheduledTask | undefined): Draft {
  const s = task?.schedule;
  const everyMin = s?.kind === "interval" ? Math.round(s.everyMs / 60_000) : 30;
  const hours = everyMin >= 60 && everyMin % 60 === 0;
  return {
    title: task?.title ?? "",
    prompt: task?.prompt ?? "",
    kind: s?.kind ?? "interval",
    hookId: s?.kind === "webhook" ? s.hookId : randomHookId(),
    secret: s?.kind === "webhook" ? (s.secret ?? "") : "",
    amount: String(hours ? everyMin / 60 : everyMin),
    unit: hours ? "hours" : "minutes",
    times: s?.kind === "fixed" ? [...s.times] : [],
    timeInput: "09:00",
    onceAt: toLocalInput(s?.kind === "once" ? s.at : nextHour(Date.now())),
    weekdays: s?.kind === "fixed" ? [...s.weekdays] : [1, 2, 3, 4, 5],
    target: task?.threadId === undefined ? "new" : "thread",
    provider: task?.provider ?? "claude",
    model: task?.model ?? "",
    threadId: task?.threadId ?? "",
    useWorktree: task?.useWorktree ?? true,
    // a one-time task that already ran comes back armed when it gets a new time
    enabled: task?.completedAt !== undefined && !task.enabled ? true : (task?.enabled ?? true),
  };
}

/** Returns the first problem with the draft, or the fields to send. */
export function validateDraft(d: Draft, now: number = Date.now()): { error: string } | { fields: TaskFields } {
  if (d.title.trim() === "") return { error: "Give the automation a title." };
  if (d.prompt.trim() === "") return { error: "Write the prompt to send." };
  const amount = Number(d.amount);
  const everyMs = amount * (d.unit === "hours" ? 3_600_000 : 60_000);
  if (d.kind === "interval" && (!Number.isFinite(amount) || everyMs < 60_000)) return { error: "The interval must be at least 1 minute." };
  if (d.kind === "fixed" && d.times.length === 0) return { error: "Add at least one time." };
  if (d.kind === "fixed" && d.weekdays.length === 0) return { error: "Pick at least one weekday." };
  const onceAt = fromLocalInput(d.onceAt);
  if (d.kind === "once" && Number.isNaN(onceAt)) return { error: "Pick the date and time to run." };
  if (d.kind === "once" && onceAt <= now) return { error: "Pick a time in the future." };
  if (d.target === "thread" && d.threadId === "") return { error: "Pick the thread to send into." };
  return {
    fields: {
      title: d.title.trim(),
      prompt: d.prompt.trim(),
      schedule:
        d.kind === "interval" ? { kind: "interval", everyMs: Math.round(everyMs) }
        : d.kind === "once" ? { kind: "once", at: onceAt }
        : d.kind === "webhook" ? { kind: "webhook", hookId: d.hookId, ...(d.secret.trim() === "" ? {} : { secret: d.secret.trim() }) }
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
  projectId,
  onSubmit,
  onCancel,
}: {
  task?: ScheduledTask;
  threads: Thread[];
  /** R9: whose machine the webhook URL points at */
  projectId?: string;
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
            <Radio name="kind" checked={d.kind === "once"} onChange={() => set({ kind: "once" })}>Once at</Radio>
            <Radio name="kind" checked={d.kind === "webhook"} onChange={() => set({ kind: "webhook" })}>On a webhook</Radio>
          </div>
          {d.kind === "interval" ? (
            <div className={styles.row}>
              <input className={`${styles.input} ${styles.num}`} type="number" min={1} aria-label="Interval" value={d.amount} onChange={(e) => set({ amount: e.target.value })} />
              <Select label="Interval unit" value={d.unit} options={UNITS} onSelect={(unit) => set({ unit })} variant="field" size="md" />
            </div>
          ) : d.kind === "once" ? (
            <div className={styles.row}>
              <input
                className={styles.input}
                type="datetime-local"
                aria-label="Run at"
                value={d.onceAt}
                onChange={(e) => set({ onceAt: e.target.value })}
              />
            </div>
          ) : d.kind === "webhook" ? (
            <>
              <WebhookUrls hookId={d.hookId} projectId={projectId} />
              <p className={styles.note}>
                The request body is appended to the prompt. With a secret, requests must carry{" "}
                <code>X-Tide-Signature: sha256=&lt;HMAC of the body&gt;</code>.
              </p>
              <input
                className={styles.input}
                aria-label="Webhook secret"
                placeholder="Secret (optional)"
                autoComplete="off"
                value={d.secret}
                onChange={(e) => set({ secret: e.target.value })}
              />
            </>
          ) : (
            <>
              <div className={styles.row}>
                {d.times.map((t) => (
                  <span key={t} className={styles.chip}>
                    {t}
                    <Button variant="quiet" aria-label={`Remove ${t}`} onClick={() => set({ times: d.times.filter((x) => x !== t) })}><Icon name="close" size={12} /></Button>
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
