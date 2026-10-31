import { lazy, Suspense, useState } from "react";
import { Value } from "typebox/value";
import { RunProfile } from "@tide/contracts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import styles from "./ProjectRunSection.module.css";

const MonacoEditor = lazy(async () => ({ default: (await import("../workbench/monaco/MonacoEditor.tsx")).MonacoEditor }));

/** Returns the parsed profile, or the first thing wrong with the text. */
export function parseProfile(text: string): { profile: RunProfile } | { error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { error: `Not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (Value.Check(RunProfile, json)) return { profile: json };
  const first = [...Value.Errors(RunProfile, json)][0];
  return { error: first ? `${first.instancePath || "/"}: ${first.message}` : "Not a run profile" };
}

/** Raw profile JSON in the lazy Monaco editor; Save validates against the contract first. */
export function RunProfileDialog({
  repoLabel,
  profile,
  onSave,
  onCancel,
}: {
  repoLabel: string;
  profile: RunProfile;
  onSave: (profile: RunProfile) => Promise<void>;
  onCancel: () => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(profile, null, 2));
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const save = async (): Promise<void> => {
    const parsed = parseProfile(text);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    try {
      await onSave({ ...parsed.profile, source: "user" });
      onCancel();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };
  return (
    <Dialog title={`Edit run profile — ${repoLabel}`} size="lg" onCancel={onCancel}>
      <div className={styles.editor}>
        <Suspense fallback={<p className={styles.muted}>Loading editor…</p>}>
          <MonacoEditor path={`${repoLabel}/.tide/run.json`} value={text} onChange={(v) => { setText(v); setError(undefined); }} />
        </Suspense>
      </div>
      {error === undefined ? null : (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
      <div className={styles.dialogActions}>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="primary" disabled={saving} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </Dialog>
  );
}
