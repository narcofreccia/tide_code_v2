import { useCallback, useEffect, useRef } from "react";
import { clearDraft, setDraft, useDrafts, type SerializedImage } from "../../state/drafts.ts";
import { serializeImages, type Attachments } from "./Attachments.tsx";

const NONE: SerializedImage[] = [];

/**
 * Binds the composer to the drafts store: text is read straight from it, images are
 * mirrored into `useAttachments`. External changes (restore, stash apply) reach the
 * attachment list; local ones are written back.
 */
export function useComposerDraft(threadId: string, attachments: Attachments) {
  const text = useDrafts((s) => s.drafts[threadId]?.text ?? "");
  const stored = useDrafts((s) => s.drafts[threadId]?.images ?? NONE);
  const hasDraft = useDrafts((s) => s.drafts[threadId] !== undefined);
  const stashCount = useDrafts((s) => s.stash.length);
  // what the attachment list is believed to hold, and whether it caught up with it
  const sync = useRef<{ thread: string; images: SerializedImage[]; caughtUp: boolean } | undefined>(undefined);
  const { replace } = attachments;

  // mount, thread switch or an external store change (stash apply) -> attachments
  useEffect(() => {
    if (sync.current?.thread === threadId && sync.current.images === stored) return;
    sync.current = { thread: threadId, images: stored, caughtUp: false };
    replace(stored);
  }, [threadId, stored, replace]);

  // local attachment edits -> store, once the list has caught up with the draft
  const localImages = attachments.images;
  useEffect(() => {
    const state = sync.current;
    if (!state || state.thread !== threadId) return;
    const serial = serializeImages(localImages);
    const same = serial.length === state.images.length && serial.every((img, i) => img.id === state.images[i]?.id);
    if (!state.caughtUp) {
      if (same) state.caughtUp = true;
      return;
    }
    if (same) return;
    setDraft(threadId, { images: serial });
    state.images = useDrafts.getState().drafts[threadId]?.images ?? NONE;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localImages]);

  const setText = useCallback((value: string) => setDraft(threadId, { text: value }), [threadId]);
  const clear = useCallback(() => clearDraft(threadId), [threadId]);
  return { text, setText, clear, hasDraft, stashCount };
}
