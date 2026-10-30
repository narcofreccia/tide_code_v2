import { useEffect, useRef, useState } from "react";
import { useDrafts } from "../../state/drafts.ts";
import { useComposerDraft } from "./useComposerDraft.ts";
import type { Thread } from "@tide/contracts";
import { newId } from "@tide/contracts";
import { interruptTurn, sendTurn, turnRequestLanded } from "../../lib/threadActions.ts";
import { steerTurn } from "../../lib/turnActions.ts";
import { useFollowUp, type FollowUpMode } from "../../lib/followUp.ts";
import { errorText } from "../../lib/dispatchOrToast.ts";
import { showToast } from "../../state/toast.ts";
import { threadProviderStatus, useProviders, useThreadHarnessLabel } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { useWorkbench } from "../../state/workbench.ts";
import { registerComposerFocus } from "../../lib/composerFocus.ts";
import { applyMention, expandMentions, findMentionQuery, normalizePastedPath } from "../../lib/mentions.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { AttachmentStrip, useAttachments } from "./Attachments.tsx";
import { imageFilesOf } from "../../lib/images.ts";
import { MentionPicker, useMentionMatches } from "./MentionPicker.tsx";
import { SlashPicker, useSlash } from "./SlashPicker.tsx";
import type { SlashCommandInfo } from "@tide/contracts";
import { ThreadLinkChips } from "./ThreadLinkChips.tsx";
import { ThreadPills } from "./ThreadPills.tsx";
import { FollowUpToggle } from "./FollowUpToggle.tsx";
import { ProviderSwitchHint } from "./ProviderSwitchHint.tsx";
import { COMPOSE_EVENT } from "./EmptyThread.tsx";
import { DraftsBar } from "./DraftsBar.tsx";
import { QueueList } from "./QueueList.tsx";
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
    ui.projectDialog !== null ||
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
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string; caret: number } | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // idempotency key of the draft in flight: a retry of the same text reuses it
  const pending = useRef<{ text: string; requestId: string } | undefined>(undefined);
  const attachments = useAttachments();
  const draft = useComposerDraft(thread.id, attachments);
  const { text, setText } = draft;
  const stash = useDrafts((s) => s.stash);
  const [stashOpen, setStashOpen] = useState(false);
  const providers = useProviders();
  const status = threadProviderStatus(providers, thread);
  const acceptsImages = status === undefined || status.caps.images;
  const followUp = useFollowUp(thread.id, status?.caps.steer === true);
  const running = thread.status === "running";
  const interrupting = thread.interrupting === true;
  const matches = useMentionMatches(thread.id, mention?.query);
  const listsCommands = status?.caps.commands === true;
  const slash = useSlash(thread, text, listsCommands);
  const harness = useThreadHarnessLabel(thread);

  useEffect(() => registerComposerFocus(() => input.current?.focus()), []);

  // "Try an example" and friends fill the composer; they never send
  useEffect(() => {
    const onCompose = (e: Event): void => {
      const detail = (e as CustomEvent<unknown>).detail;
      if (typeof detail !== "string") return;
      setText(detail);
      setMention(undefined);
      slash.close();
      input.current?.focus();
    };
    window.addEventListener(COMPOSE_EVENT, onCompose);
    return () => window.removeEventListener(COMPOSE_EVENT, onCompose);
  }, []);

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
    const found = findMentionQuery(value, caret);
    setMention(found ? { ...found, caret } : undefined);
    if (found) slash.close();
    else slash.sync(value, caret);
    setCursor(0);
  };

  const placeCaret = (caret: number): void => {
    requestAnimationFrame(() => {
      const element = input.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(caret, caret);
    });
  };

  /** Inserts `/name `; the harness runs it (skills included) when the text is sent. */
  const pickCommand = (command: SlashCommandInfo): void => {
    const next = slash.apply(text, command);
    if (!next) return;
    setText(next.text);
    placeCaret(next.caret);
  };

  const pick = (path: string): void => {
    if (!mention) return;
    const next = applyMention(text, mention, mention.caret, path);
    setText(next.text);
    setMention(undefined);
    placeCaret(next.caret);
  };

  /**
   * Sending while the thread runs is allowed: the server queues the turn behind
   * the live one, so a follow-up never has to wait for the agent to stop.
   */
  const send = (how?: FollowUpMode, background = false): void => {
    const value = text.trim();
    if ((!value && attachments.images.length === 0) || busy) return;
    const steer = running && (how ?? followUp.mode) === "steer" && followUp.canSteer;
    const images = attachments.images.map((image) => ({ mediaType: image.mediaType, data: image.data }));
    const prompt = expandMentions(value);
    if (pending.current?.text !== prompt) pending.current = { text: prompt, requestId: newId() };
    const { requestId } = pending.current;
    const sent = (): void => {
      pending.current = undefined;
      draft.clear();
      attachments.clear();
      if (background) useUi.getState().showMission();
    };
    setBusy(true);
    const delivery = steer ? steerTurn(thread.id, prompt, images, requestId) : sendTurn(thread.id, prompt, images, requestId);
    delivery
      .then(sent)
      .catch((error: unknown) => {
        // the first attempt landed before the socket dropped: the retry was refused, not lost
        if (!steer && turnRequestLanded(thread.id, requestId)) sent();
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
    if (slash.query && slash.matches.length > 0) {
      const count = slash.matches.length;
      if (e.key === "ArrowDown") setCursor((v) => Math.min(count - 1, v + 1));
      else if (e.key === "ArrowUp") setCursor((v) => Math.max(0, v - 1));
      else if ((e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.altKey) || e.key === "Tab") {
        const command = slash.matches[Math.min(cursor, count - 1)];
        if (command) pickCommand(command);
      } else if (e.key === "Escape") slash.close();
      else return onDefaultKey(e);
      e.preventDefault();
      return;
    }
    onDefaultKey(e);
  };

  const onDefaultKey = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key !== "Enter") return;
    // running: ⌘↵ sends in the selected mode; idle: ⌘↵ sends in the background. ⌥↵ sends the other mode
    if (e.metaKey || e.ctrlKey) {
      e.preventDefault();
      if (running) send(followUp.mode);
      else send(undefined, true);
    } else if (e.altKey) {
      e.preventDefault();
      send(running ? followUp.alternate : undefined);
    }
  };

  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, text.split("\n").length));
  const nothingToSend = text.trim() === "" && attachments.images.length === 0;
  const primaryLabel = !running ? "Send" : followUp.mode === "steer" ? "Steer" : "Queue";

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
      {!mention && slash.query ? <SlashPicker slash={slash} cursor={cursor} onPick={pickCommand} /> : null}
      <AttachmentStrip images={attachments.images} onRemove={attachments.remove} />
      <QueueList threadId={thread.id} running={running} canSteer={followUp.canSteer} />
      <textarea
        ref={input}
        className={styles.input}
        aria-label="Message"
        placeholder={listsCommands ? "Ask the agent… (@ to mention a file, / for commands)" : "Ask the agent… (@ to mention a file)"}
        rows={rows}
        value={text}
        onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
        onClick={(e) => {
          const element = e.currentTarget;
          const caret = element.selectionStart ?? 0;
          const found = findMentionQuery(element.value, caret);
          setMention(found ? { ...found, caret } : undefined);
          if (found) slash.close();
          else slash.sync(element.value, caret);
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
      {slash.unknown === undefined ? null : (
        <p className={styles.switchHint} role="status">
          Unknown command for {harness}; it will be sent as text
        </p>
      )}
      <div className={styles.settings}>
        <ThreadPills thread={thread} />
        <ThreadLinkChips threadId={thread.id} />
      </div>
      <div className={styles.actions}>
        {running ? <FollowUpToggle followUp={followUp} provider={thread.provider} /> : null}
        <DraftsBar
          threadId={thread.id}
          restored={draft.hasDraft}
          hasText={text.trim() !== ""}
          stash={stash}
          open={stashOpen}
          onOpen={setStashOpen}
        />
        <span className={styles.hint}>
          {interrupting ? (
            <span className={styles.interrupting}>interrupting…</span>
          ) : (
            <>
              <Kbd>⌘↵</Kbd> {running ? followUp.mode : "send in background"}
              {running && followUp.canSteer ? (
                <>
                  {" · "}
                  <Kbd>⌥↵</Kbd> {followUp.alternate}
                </>
              ) : null}
            </>
          )}
        </span>
        <span className={styles.buttons}>
          {running ? (
            <Button
              variant="quietDanger"
              disabled={interrupting}
              title="Stop the running turn (Esc)"
              onClick={() => interruptTurn(thread.id)}
            >
              <span>Stop</span>
              <Kbd>Esc</Kbd>
            </Button>
          ) : null}
          <Button variant="primary" onClick={() => send()} disabled={busy || nothingToSend}>
            {primaryLabel}
          </Button>
        </span>
      </div>
      <ProviderSwitchHint thread={thread} />
    </div>
  );
}
