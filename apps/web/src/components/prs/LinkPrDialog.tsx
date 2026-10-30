import { useEffect, useRef, useState } from "react";
import { useUi } from "../../state/ui.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { Button } from "../ui/Button.tsx";
import { Dialog } from "../ui/Dialog.tsx";
import { linkPr } from "./prActions.ts";
import styles from "./LinkPrDialog.module.css";

/** "Link a PR…": a number or URL, resolved by the server on the forge (`pr.link`). */
export function LinkPrDialog({ threadId, onClose }: { threadId: string; onClose: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const submit = (): void => {
    const pr = value.trim();
    if (pr === "" || busy) return;
    setBusy(true);
    setError(undefined);
    linkPr(threadId, pr)
      .then(onClose)
      .catch((e: unknown) => {
        setBusy(false);
        setError(errorText(e));
      });
  };

  return (
    <Dialog title="Link a pull request" onCancel={onClose}>
      <label className={styles.field}>
        <span className={styles.label}>PR number or URL</span>
        <input
          ref={input}
          className={styles.input}
          aria-label="PR number or URL"
          placeholder="#42 or https://github.com/owner/repo/pull/42"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit();
          }}
        />
      </label>
      <p className={styles.hint}>The thread then watches it: checks, reviews and the merge show up here.</p>
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button variant="quiet" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" disabled={value.trim() === "" || busy} onClick={submit}>
          {busy ? "Linking…" : "Link"}
        </Button>
      </div>
    </Dialog>
  );
}

/** Mounted once in the app shell; the thread header's menu opens it through the ui store. */
export function LinkPrDialogHost() {
  const threadId = useUi((s) => s.linkPrThreadId);
  const setLinkPrThread = useUi((s) => s.setLinkPrThread);
  if (threadId === null) return null;
  return <LinkPrDialog threadId={threadId} onClose={() => setLinkPrThread(null)} />;
}
