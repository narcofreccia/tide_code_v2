import { useRef, useState } from "react";
import type { AttachmentRef, Thread } from "@tide/contracts";
import { newId } from "@tide/contracts";
import { forgetFiles, uploadFiles, type DraftFile } from "../../lib/attachments.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import type { FollowUp, FollowUpMode } from "../../lib/followUp.ts";
import { expandMentions, expandThreadMentions } from "../../lib/mentions.ts";
import { sendTurn, turnRequestLanded } from "../../lib/threadActions.ts";
import { steerTurn } from "../../lib/turnActions.ts";
import { useModel } from "../../state/model.ts";
import { showToast } from "../../state/toast.ts";
import { useUi } from "../../state/ui.ts";
import type { PendingImage } from "../../lib/images.ts";

interface Pending {
  text: string;
  fileKey: string;
  requestId: string;
  /** uploaded once per draft: a retry after a dropped socket does not upload twice */
  refs?: AttachmentRef[];
}

export interface ComposerSendInput {
  thread: Thread;
  text: string;
  images: PendingImage[];
  files: DraftFile[];
  followUp: FollowUp;
  onSent: () => void;
}

/** The prompt as the harness gets it: `@path` backticked, `@thread:<id>` expanded to context lines. */
export function promptOf(text: string, hasImages: boolean, hasFiles: boolean): string {
  const titleOf = (id: string): string | undefined => useModel.getState().model.threads[id]?.title;
  const prompt = expandThreadMentions(expandMentions(text.trim()), titleOf);
  if (prompt !== "") return prompt;
  // the turn needs some text; the server lists file paths under it
  if (hasFiles) return "See the attached files.";
  return hasImages ? "See the attached images." : "";
}

/**
 * Sending: uploads pending files first (`attachments.upload`), then requests or steers
 * the turn with their refs. Sending while the thread runs is allowed: the server
 * queues the turn behind the live one.
 */
export function useComposerSend({ thread, text, images, files, followUp, onSent }: ComposerSendInput) {
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const pending = useRef<Pending | undefined>(undefined);
  const running = thread.status === "running";

  const send = async (how?: FollowUpMode, background = false): Promise<void> => {
    if ((text.trim() === "" && images.length === 0 && files.length === 0) || busy) return;
    const steer = running && (how ?? followUp.mode) === "steer" && followUp.canSteer;
    const imageInputs = images.map((image) => ({ mediaType: image.mediaType, data: image.data }));
    const prompt = promptOf(text, images.length > 0, files.length > 0);
    const fileKey = files.map((f) => f.id).join(",");
    if (pending.current?.text !== prompt || pending.current.fileKey !== fileKey) {
      pending.current = { text: prompt, fileKey, requestId: newId() };
    }
    const current = pending.current;
    const sent = (): void => {
      pending.current = undefined;
      forgetFiles(files.map((f) => f.id));
      onSent();
      if (background) useUi.getState().showMission();
    };
    setBusy(true);
    try {
      if (files.length > 0 && current.refs === undefined) {
        setUploading(files.length);
        try {
          current.refs = await uploadFiles(thread.id, files);
        } catch (error: unknown) {
          showToast(`Uploading attachments failed: ${errorText(error)}`);
          return;
        } finally {
          setUploading(0);
        }
      }
      const refs = current.refs ?? [];
      try {
        await (steer
          ? steerTurn(thread.id, prompt, imageInputs, current.requestId, refs)
          : sendTurn(thread.id, prompt, imageInputs, current.requestId, refs));
        sent();
      } catch (error: unknown) {
        // the first attempt landed before the socket dropped: the retry was refused, not lost
        if (!steer && turnRequestLanded(thread.id, current.requestId)) sent();
        else showToast(`Sending failed: ${errorText(error)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return { send, busy, uploading };
}
