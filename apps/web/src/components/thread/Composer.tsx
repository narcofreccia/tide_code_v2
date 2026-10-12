import { useEffect, useRef, useState } from "react";
import { selectQueuedTurns } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { newId } from "@tide/contracts";
import { interruptTurn, sendTurn, turnRequestLanded } from "../../lib/threadActions.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { showToast } from "../../state/toast.ts";
import { useModel } from "../../state/model.ts";
import { providerStatus, useProviders } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { useWorkbench } from "../../state/workbench.ts";
import { registerComposerFocus } from "../../lib/composerFocus.ts";
import { applyMention, expandMentions, findMentionQuery, normalizePastedPath } from "../../lib/mentions.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { AttachmentStrip, useAttachments } from "./Attachments.tsx";
import { imageFilesOf } from "../../lib/images.ts";
import { MentionPicker, useMentionMatches } from "./MentionPicker.tsx";
import { ThreadLinkChips } from "./ThreadLinkChips.tsx";
import { ThreadPills } from "./ThreadPills.tsx";
import styles from "./Composer.module.css";

const NO_IMAGES = "This harness does not accept images";

const MIN_ROWS = 3;
const MAX_ROWS = 8;

/** Any layer that owns Escape ahead of the thread: dialog, popover, palette, picker. */
function anOverlayIsOpen(): boolean {
  const ui = useUi.getState();
  if (
    ui.paletteOpen ||
    ui.threadDialog !== null ||
    ui.newProjectOpen ||
    ui.newThreadProjectId !== null ||
    ui.linksProjectId !== null ||
    ui.newExpertsProjectId !== null ||
    useWorkbench.getState().quickOpen
  ) {
    return true;
  }
  // Popover panels and modals are portalled and both carry role="dialog"
  return typeof document !== "undefined" && document.querySelector('[role="dialog"]') !== null;
}

/**
 * True while focus sits in the composer or anywhere else in the thread column.
 * Focus nowhere in particular counts too, so Esc still stops the turn before the
 * user has clicked anything; focus in the workbench or a side surface does not.
 */
function threadColumnHasFocus(composer: HTMLElement | null): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  if (!(active instanceof Element)) return false;
  return composer?.contains(active) === true || active.closest("[data-thread-column]") !== null;
}

export function Composer({ thread }: { thread: Thread }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string; caret: number } | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const [justQueued, setJustQueued] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // idempotency key of the draft in flight: a retry of the same text reuses it
  const pending = useRef<{ text: string; requestId: string } | undefined>(undefined);
  const attachments = useAttachments();
  const providers = useProviders();
  const status = providerStatus(providers, thread.provider);
  const acceptsImages = status === undefined || status.caps.images;
  const queuedCount = useModel((s) => selectQueuedTurns(s.model, thread.id).length);
  const running = thread.status === "running";
  const interrupting = thread.interrupting === true;
  const matches = useMentionMatches(thread.id, mention?.query);

  useEffect(() => registerComposerFocus(() => input.current?.focus()), []);

  // Esc is also "close" for dialogs, popovers, the palette and Settings; stopping
  // the turn is only what it means while the thread column itself owns the focus.
  useEffect(() => {
    if (!running || interrupting) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (anOverlayIsOpen()) return;
      if (!threadColumnHasFocus(root.current)) return;
      e.preventDefault();
      interruptTurn(thread.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, interrupting, thread.id]);

  const attach = (files: File[]): void => {
    if (files.length === 0) return;
    if (!acceptsImages) {
      showToast(NO_IMAGES);
      return;
    }
    void attachments.add(files);
  };

  const sync = (value: string, caret: number): void => {
    setText(value);
    setJustQueued(false);
    const found = findMentionQuery(value, caret);
    setMention(found ? { ...found, caret } : undefined);
    setCursor(0);
  };

  const pick = (path: string): void => {
    if (!mention) return;
    const next = applyMention(text, mention, mention.caret, path);
    setText(next.text);
    setMention(undefined);
    requestAnimationFrame(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
    });
  };

  /**
   * Sending while the thread runs is allowed: the server queues the turn behind
   * the live one, so a follow-up never has to wait for the agent to stop.
   */
  const send = (): void => {
    const value = text.trim();
    if ((!value && attachments.images.length === 0) || busy) return;
    const wasRunning = running;
    const images = attachments.images.map((image) => ({ mediaType: image.mediaType, data: image.data }));
    const prompt = expandMentions(value);
    if (pending.current?.text !== prompt) pending.current = { text: prompt, requestId: newId() };
    const { requestId } = pending.current;
    const sent = (): void => {
      pending.current = undefined;
      setText("");
      attachments.clear();
      setJustQueued(wasRunning);
    };
    setBusy(true);
    sendTurn(thread.id, prompt, images, requestId)
      .then(sent)
      .catch((error: unknown) => {
        // the first attempt landed before the socket dropped: the retry was refused, not lost
        if (turnRequestLanded(thread.id, requestId)) sent();
        else showToast(`Sending failed: ${errorText(error)}`);
      })
      .finally(() => setBusy(false));
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention && matches.paths.length > 0) {
      if (e.key === "ArrowDown") setCursor((v) => Math.min(matches.paths.length - 1, v + 1));
      else if (e.key === "ArrowUp") setCursor((v) => Math.max(0, v - 1));
      else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) pick(matches.paths[cursor] ?? "");
      else if (e.key === "Tab") pick(matches.paths[cursor] ?? "");
      else if (e.key === "Escape") setMention(undefined);
      else return onDefaultKey(e);
      e.preventDefault();
      return;
    }
    onDefaultKey(e);
  };

  const onDefaultKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      send();
    }
  };

  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, text.split("\n").length));
  const nothingToSend = text.trim() === "" && attachments.images.length === 0;
  // the model catches up a beat after the dispatch resolves; `justQueued` covers the gap
  const queued = queuedCount > 0 ? `+${queuedCount} queued` : justQueued ? "queued" : undefined;

  return (
    <div
      className={styles.composer}
      ref={root}
      onDragOver={(e) => {
        if (imageFilesOf(e.dataTransfer).length > 0 || (e.dataTransfer?.types ?? []).includes("Files")) {
          e.preventDefault();
        }
      }}
      onDrop={(e) => {
        const files = imageFilesOf(e.dataTransfer);
        if (files.length === 0) return;
        e.preventDefault();
        attach(files);
      }}
    >
      {mention ? <MentionPicker matches={matches} cursor={cursor} onPick={pick} /> : null}
      <AttachmentStrip images={attachments.images} onRemove={attachments.remove} />
      <textarea
        ref={input}
        className={styles.input}
        aria-label="Message"
        placeholder="Ask the agent… (@ to mention a file)"
        rows={rows}
        value={text}
        onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onClick={(e) => {
          const element = e.currentTarget;
          const found = findMentionQuery(element.value, element.selectionStart ?? 0);
          setMention(found ? { ...found, caret: element.selectionStart ?? 0 } : undefined);
        }}
        onPaste={(e) => {
          const files = imageFilesOf(e.clipboardData);
          if (files.length > 0) {
            e.preventDefault();
            attach(files);
            return;
          }
          const pasted = e.clipboardData.getData("text");
          const relative = normalizePastedPath(pasted, thread.worktreePath);
          if (relative === pasted) return;
          e.preventDefault();
          const element = e.currentTarget;
          const start = element.selectionStart ?? text.length;
          const end = element.selectionEnd ?? start;
          const value = `${text.slice(0, start)}${relative}${text.slice(end)}`;
          sync(value, start + relative.length);
        }}
        onKeyDown={onKeyDown}
      />
      <div className={styles.actions}>
        <ThreadPills thread={thread} />
        <ThreadLinkChips threadId={thread.id} />
        <span className={styles.hint}>
          {queued === undefined ? null : <span className={styles.queued}>{queued}</span>}
          {interrupting ? (
            <span className={styles.interrupting}>interrupting…</span>
          ) : (
            <>
              <Kbd>⌘↵</Kbd> {running ? "queue" : "send"}
              {running ? (
                <>
                  {" · "}
                  <Kbd>Esc</Kbd> stop
                </>
              ) : null}
            </>
          )}
        </span>
        {running ? (
          <Button variant="quiet" disabled={interrupting} onClick={() => interruptTurn(thread.id)}>
            Stop
          </Button>
        ) : null}
        <Button variant="primary" onClick={send} disabled={busy || nothingToSend}>
          {running ? "Queue" : "Send"}
        </Button>
      </div>
    </div>
  );
}
