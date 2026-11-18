import { useRef, useState } from "react";
import { threadSendBlock } from "@tide/client";
import type { AttachmentRef, ProviderKind, Thread } from "@tide/contracts";
import { newId } from "@tide/contracts";
import { forgetFiles, uploadFiles, type DraftFile } from "../../lib/attachments.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import type { FollowUp, FollowUpMode } from "../../lib/followUp.ts";
import { expandDelegateMentions, expandMentions, expandThreadMentions } from "../../lib/mentions.ts";
import { sendTurn, turnRequestLanded } from "../../lib/threadActions.ts";
import { steerTurn } from "../../lib/turnActions.ts";
import { disarmFreshSession, isFreshSessionArmed } from "../../state/freshSession.ts";
import { useModel } from "../../state/model.ts";
import { offlineReason, useThreadEnvStatus } from "../../state/threadEnv.ts";
import { useProvidersStore } from "../../state/providers.ts";
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

const delegateLabelOf = (id: string): { label: string; kind: ProviderKind } | undefined => {
  const p = useProvidersStore.getState().providers.find((x) => x.id === id);
  return p === undefined ? undefined : { label: p.label, kind: p.kind };
};

/** The prompt as the harness gets it: `@path` backticked, `@thread:<id>` expanded to context lines. */
export function promptOf(text: string, hasImages: boolean, hasFiles: boolean): string {
  const titleOf = (id: string): string | undefined => useModel.getState().model.threads[id]?.title;
  const threadsExpanded = expandThreadMentions(expandMentions(text.trim()), titleOf);
  const prompt = expandDelegateMentions(threadsExpanded, delegateLabelOf);
  if (prompt !== "") return prompt;
  // the turn needs some text; the server lists file paths under it
  if (hasFiles) return "See the attached files.";
  return hasImages ? "See the attached images." : "";
}

/**
 * Sending: uploads pending files first (`attachments.upload`), then requests or steers
 * the turn with their refs. Sending while the thread runs is allowed: the server
 * queues the turn behind the live one.
 *
 * Offline (the thread's machine is not connected) a send does nothing and the draft stays:
 * nothing queues commands across a drop, so a "sent" message would be lost. `offline` is
 * the reason to show, undefined while connected.
 *
 * Blocked (`threadSendBlock`: the worktree is gone, archived, rolling back, a quota holds it) a
 * send does nothing either: the server would refuse the turn. `blocked` says why and whether a fork
 * can carry on. A quota holds new turns only: a steer into the running turn still goes (`quota`
 * keeps the hold for the notice above the composer).
 */
export function useComposerSend({ thread, text, images, files, followUp, onSent }: ComposerSendInput) {
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(0);
  const pending = useRef<Pending | undefined>(undefined);
  const running = thread.status === "running";
  const env = useThreadEnvStatus(thread.id);
  const offline = env.online ? undefined : offlineReason(env);
  // quotas live on threads and projects: re-render on those maps, read the rest of the model as is
  useModel((s) => s.model.threads);
  useModel((s) => s.model.projects);
  const block = threadSendBlock(thread, { model: useModel.getState().model, now: Date.now() });
  const quota = block?.kind === "quota" ? block.quota : undefined;
  const steersNow = running && followUp.mode === "steer" && followUp.canSteer;
  const blocked = quota !== undefined && steersNow ? undefined : block;

  /** `override` replaces the draft text (`/clear <prompt>` sends the prompt after the command). */
  const send = async (how?: FollowUpMode, background = false, override?: { text: string; fresh?: boolean }): Promise<void> => {
    const body = override?.text ?? text;
    const fresh = override?.fresh === true || isFreshSessionArmed(thread.id);
    const steer = !fresh && running && (how ?? followUp.mode) === "steer" && followUp.canSteer;
    const refused = block !== undefined && !(block.kind === "quota" && steer);
    if ((body.trim() === "" && images.length === 0 && files.length === 0) || busy || offline !== undefined || refused) return;
    const imageInputs = images.map((image) => ({ mediaType: image.mediaType, data: image.data }));
    const prompt = promptOf(body, images.length > 0, files.length > 0);
    const fileKey = files.map((f) => f.id).join(",");
    if (pending.current?.text !== prompt || pending.current.fileKey !== fileKey) {
      pending.current = { text: prompt, fileKey, requestId: newId() };
    }
    const current = pending.current;
    const sent = (): void => {
      pending.current = undefined;
      if (fresh) disarmFreshSession(thread.id);
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
          : sendTurn(thread.id, prompt, imageInputs, current.requestId, refs, fresh ? { freshSession: true } : {}));
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

  return { send, busy, uploading, offline, blocked, quota };
}
