import { useCallback } from "react";
import { admitFiles, fileBytesAvailable, forgetFiles, rememberFile, type DraftFile } from "../../lib/attachments.ts";
import { formatBytes } from "../../lib/images.ts";
import { threadMentionIds, removeThreadMention } from "../../lib/mentions.ts";
import { setDraft, useDrafts } from "../../state/drafts.ts";
import { useModel } from "../../state/model.ts";
import { showToast } from "../../state/toast.ts";
import styles from "./Attachments.module.css";

const NONE: DraftFile[] = [];

export interface FileAttachments {
  files: DraftFile[];
  add: (files: File[]) => void;
  remove: (id: string) => void;
}

/** Non-image files of the thread's draft. The list lives in the draft (metadata); bytes in memory. */
export function useFileAttachments(threadId: string): FileAttachments {
  const files = useDrafts((s) => s.drafts[threadId]?.files ?? NONE);

  const add = useCallback(
    (incoming: File[]): void => {
      if (incoming.length === 0) return;
      const current = useDrafts.getState().drafts[threadId]?.files ?? [];
      const remembered = incoming.map(rememberFile);
      const admitted = admitFiles(current, remembered);
      const kept = new Set(admitted.files.map((f) => f.id));
      forgetFiles(remembered.filter((f) => !kept.has(f.id)).map((f) => f.id));
      if (admitted.refused !== undefined) showToast(admitted.refused);
      setDraft(threadId, { files: admitted.files });
    },
    [threadId],
  );

  const remove = useCallback(
    (id: string): void => {
      const current = useDrafts.getState().drafts[threadId]?.files ?? [];
      forgetFiles([id]);
      setDraft(threadId, { files: current.filter((f) => f.id !== id) });
    },
    [threadId],
  );

  return { files, add, remove };
}

/** Chips for the files that will be uploaded with the next prompt. */
export function FileChips({ files, onRemove }: { files: readonly DraftFile[]; onRemove: (id: string) => void }) {
  if (files.length === 0) return null;
  return (
    <ul className={styles.strip} aria-label="Attached files">
      {files.map((file) => {
        const stale = !fileBytesAvailable(file.id);
        return (
          <li
            key={file.id}
            className={`${styles.item} ${styles.file} ${stale ? styles.stale : ""}`}
            title={stale ? "Re-attach: file contents are not kept across reloads" : file.mediaType}
          >
            <span aria-hidden="true">📄</span>
            <span className={styles.name}>{file.name}</span>
            <span className={styles.meta}>{formatBytes(file.bytes)}</span>
            <button type="button" className={styles.remove} aria-label={`Remove ${file.name}`} onClick={() => onRemove(file.id)}>
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** The threads an `@thread:<id>` in the text points at; ✕ takes the token out of the text. */
export function ThreadContextChips({ text, onChange }: { text: string; onChange: (text: string) => void }) {
  const threads = useModel((s) => s.model.threads);
  const ids = threadMentionIds(text);
  if (ids.length === 0) return null;
  return (
    <ul className={styles.strip} aria-label="Context threads">
      {ids.map((id) => (
        <li key={id} className={`${styles.item} ${styles.file}`} title={`Thread ${id}`}>
          <span aria-hidden="true">💬</span>
          <span className={styles.name}>{threads[id]?.title ?? id}</span>
          <button
            type="button"
            className={styles.remove}
            aria-label={`Remove context thread ${threads[id]?.title ?? id}`}
            onClick={() => onChange(removeThreadMention(text, id))}
          >
            ×
          </button>
        </li>
      ))}
    </ul>
  );
}
