import { useId, useState } from "react";
import { quotaView } from "@tide/client";
import type { Project, Quota, QuotaScope, Thread } from "@tide/contracts";
import { setQuota } from "../../lib/quota.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { SettingNote } from "../settings/ui/SettingsGroup.tsx";
import { SettingToggle } from "../settings/ui/SettingToggle.tsx";
import { QuotaMeter } from "./QuotaMeter.tsx";
import styles from "./Quota.module.css";

type OnExceed = Quota["onExceed"];

const AT_CAP = [
  { value: "hold" as const, label: "Hold new turns", description: "The running turn finishes; new and queued turns wait" },
  { value: "warn" as const, label: "Warn only", description: "Nothing is held" },
];

/** What the two fields hold, as typed. */
interface Draft {
  share: string;
  usd: string;
  onExceed: OnExceed;
}

function draftOf(quota: Quota | undefined): Draft {
  return {
    share: quota?.sharePct === undefined ? "" : String(quota.sharePct),
    usd: quota?.usdPerWeek === undefined ? "" : String(quota.usdPerWeek),
    onExceed: quota?.onExceed ?? "hold",
  };
}

/** The quota a draft stands for, or the reason it cannot be saved. */
export function parseQuotaDraft(draft: Draft): { quota: Quota } | { error: string } {
  const share = draft.share.trim();
  const usd = draft.usd.trim();
  if (share === "" && usd === "") return { error: "Set a share, an amount, or both." };
  const quota: Quota = { onExceed: draft.onExceed };
  if (share !== "") {
    const value = Number(share);
    if (!Number.isFinite(value) || value < 1 || value > 100) return { error: "The share is a percent from 1 to 100." };
    quota.sharePct = value;
  }
  if (usd !== "") {
    const value = Number(usd);
    if (!Number.isFinite(value) || value <= 0) return { error: "The amount must be more than $0." };
    quota.usdPerWeek = value;
  }
  return { quota };
}

/**
 * The usage quota of a project or a thread: a share of the weekly window, an amount per week
 * (USD at list prices), or both, and what happens at the cap. One component for Settings ›
 * Projects and the thread menu's dialog. `limit` (R19) is why this device may not change it.
 */
export function QuotaEditor({
  scope,
  entity,
  limit,
  onDone,
  onRemoved,
  startOn = false,
}: {
  scope: QuotaScope;
  entity: Pick<Project | Thread, "id" | "title" | "quota" | "quotaState">;
  limit?: string | undefined;
  /** called after Save or Remove (a dialog closes) */
  onDone?: () => void;
  /** called after Remove */
  onRemoved?: () => void;
  /** open on the fields even without a quota (opened from a menu) */
  startOn?: boolean;
}) {
  const [enabled, setEnabled] = useState(startOn || entity.quota !== undefined);
  const [draft, setDraft] = useState<Draft>(() => draftOf(entity.quota));
  const [error, setError] = useState<string | undefined>(undefined);
  const id = useId();
  const off = limit !== undefined;
  const view = quotaView(scope, entity);

  const save = (): void => {
    const parsed = parseQuotaDraft(draft);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setError(undefined);
    setQuota(scope, entity.id, parsed.quota);
    onDone?.();
  };
  const remove = (): void => {
    setQuota(scope, entity.id, undefined);
    setDraft(draftOf(undefined));
    setEnabled(false);
    onRemoved?.();
    onDone?.();
  };
  const edit = (patch: Partial<Draft>): void => {
    setDraft({ ...draft, ...patch });
    setError(undefined);
  };

  return (
    <div className={styles.editor} aria-label={`Usage quota of ${entity.title}`} role="group">
      <div className={styles.head}>
        <label className={styles.headLabel} htmlFor={`${id}-on`}>
          Usage quota
        </label>
        <SettingToggle
          id={`${id}-on`}
          checked={enabled}
          disabled={off}
          onChange={(next) => {
            if (!next && entity.quota !== undefined) remove();
            else setEnabled(next);
          }}
        />
        {view === undefined ? null : (
          <span className={styles.status}>
            <QuotaMeter view={view} wide label={view.figureText ?? "Measuring"} />
          </span>
        )}
      </div>
      {enabled ? (
        <>
          <div className={styles.fields}>
            <label className={styles.fieldLabel} htmlFor={`${id}-share`}>
              Share of the weekly window
            </label>
            <span className={styles.field}>
              <input
                id={`${id}-share`}
                className={styles.input}
                type="number"
                inputMode="numeric"
                min={1}
                max={100}
                step={1}
                placeholder="30"
                value={draft.share}
                disabled={off}
                title={limit}
                aria-invalid={error !== undefined}
                onChange={(e) => edit({ share: e.target.value })}
              />
              <span className={styles.unit}>%</span>
            </span>
            <label className={styles.fieldLabel} htmlFor={`${id}-usd`}>
              Amount per week
            </label>
            <span className={styles.field}>
              <span className={styles.unit}>$</span>
              <input
                id={`${id}-usd`}
                className={styles.input}
                type="number"
                inputMode="numeric"
                min={0}
                step="any"
                placeholder="20"
                value={draft.usd}
                disabled={off}
                title={limit}
                aria-invalid={error !== undefined}
                onChange={(e) => edit({ usd: e.target.value })}
              />
              <span className={styles.unit}>USD at list prices</span>
            </span>
            <span className={styles.fieldLabel}>At the cap</span>
            <Select
              label="At the cap"
              value={draft.onExceed}
              options={AT_CAP}
              onSelect={(onExceed) => edit({ onExceed })}
              disabled={off}
              variant="field"
              size="md"
            />
          </div>
          {error === undefined ? null : (
            <span className={styles.error} role="alert">
              {error}
            </span>
          )}
          <SettingNote>
            {scope === "project" ? "Counts this project's threads and their sub-threads" : "Counts this thread and its sub-threads"}, on each
            harness account.
            <br />
            The share is an estimate. It trips early when the same subscription is used on other devices.
          </SettingNote>
          <div className={styles.actions}>
            <Button variant="primary" disabled={off} title={limit} onClick={save}>
              Save
            </Button>
            {entity.quota === undefined ? null : (
              <Button variant="quietDanger" className={styles.push} disabled={off} title={limit} onClick={remove}>
                Remove
              </Button>
            )}
          </div>
        </>
      ) : null}
      {off ? (
        <p className={styles.note} role="status">
          {limit}
        </p>
      ) : null}
    </div>
  );
}
