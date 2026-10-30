import { useEffect, useState } from "react";
import { openPreviewTab } from "../../../state/workbench.ts";
import { Button } from "../../ui/Button.tsx";
import { Icon } from "../../ui/Icon.tsx";
import styles from "./Preview.module.css";

/** Full rights for a dev server on another origin; never `allow-same-origin` on Tide's own. */
export function previewSandbox(url: string): string {
  const base = "allow-scripts allow-forms allow-popups allow-modals";
  try {
    const sameOrigin = typeof window !== "undefined" && new URL(url, window.location.href).origin === window.location.origin;
    return sameOrigin ? base : `${base} allow-same-origin`;
  } catch {
    return base;
  }
}

/** Accepts `localhost:5173` and friends; the iframe needs a scheme. */
export function normalizePreviewUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "" || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

/** A dev server in the workbench: URL bar, reload, open in the browser. */
export function PreviewTab({ threadId, url }: { threadId: string; url: string }) {
  const [draft, setDraft] = useState(url);
  const [nonce, setNonce] = useState(0);
  useEffect(() => setDraft(url), [url]);

  return (
    <div className={styles.preview}>
      <form
        className={styles.bar}
        onSubmit={(e) => {
          e.preventDefault();
          const next = normalizePreviewUrl(draft);
          if (next === "") return;
          if (next === url) setNonce((n) => n + 1);
          else openPreviewTab(threadId, next);
        }}
      >
        <Button variant="quiet" type="button" title="Reload" aria-label="Reload preview" onClick={() => setNonce((n) => n + 1)}>
          <Icon name="refresh" size={14} />
        </Button>
        <input
          className={styles.url}
          aria-label="Preview URL"
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
        />
        <a className={styles.external} href={url} target="_blank" rel="noreferrer">
          Open in browser
          <Icon name="external" size={12} />
        </a>
      </form>
      <iframe key={`${url}#${nonce}`} className={styles.frame} title="Preview" src={url} sandbox={previewSandbox(url)} />
    </div>
  );
}
