import { useEffect, useRef, useState } from "react";
import { getDraft, useDrafts } from "../../state/drafts.ts";
import { useComposerDraft } from "./useComposerDraft.ts";
import type { Thread } from "@tide/contracts";
import { interruptTurn } from "../../lib/threadActions.ts";
import { useFollowUp } from "../../lib/followUp.ts";
import { threadProviderStatus, useProviders, useThreadHarnessLabel } from "../../state/providers.ts";
import { registerComposerFocus } from "../../lib/composerFocus.ts";
import {
  THREAD_DRAG_TYPE,
  THREAD_PREFIX,
  applyMention,
  findMentionQuery,
  insertAt,
  normalizePastedPath,
  threadMention,
  threadMentionIds,
} from "../../lib/mentions.ts";
import { filesOf, splitFiles, transferHasFiles } from "../../lib/attachments.ts";
import { applyCompose } from "../../lib/cite.ts";
import { interceptSide, useComposeEvent, useEscInterrupt, type ComposerScope } from "./composerScope.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { AttachmentStrip, useAttachments } from "./Attachments.tsx";
import { FileChips, ThreadContextChips, useFileAttachments } from "./FileAttachments.tsx";
import { MentionPicker, useMentionMatches, type MentionItem } from "./MentionPicker.tsx";
import { useComposerSend } from "./useComposerSend.ts";
import { SlashPicker, useSlash } from "./SlashPicker.tsx";
import type { SlashCommandInfo } from "@tide/contracts";
import { ThreadLinkChips } from "./ThreadLinkChips.tsx";
import { ThreadPills } from "./ThreadPills.tsx";
import { FollowUpToggle } from "./FollowUpToggle.tsx";
import { ProviderSwitchHint } from "./ProviderSwitchHint.tsx";
import { DraftsBar } from "./DraftsBar.tsx";
import { QueueList } from "./QueueList.tsx";
import styles from "./Composer.module.css";

const MIN_ROWS = 2;
const MAX_ROWS = 12;

/** `scope="side"`: a side chat's composer in the workbench (R16; see composerScope.ts). */
export function Composer({ thread, scope = "main" }: { thread: Thread; scope?: ComposerScope }) {
  const [mention, setMention] = useState<{ start: number; query: string; caret: number } | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const attachments = useAttachments();
  const fileAttachments = useFileAttachments(thread.id);
  const draft = useComposerDraft(thread.id, attachments);
  const { text, setText } = draft;
  const stash = useDrafts((s) => s.stash);
  const [stashOpen, setStashOpen] = useState(false);
  const [dropping, setDropping] = useState(false);
  const providers = useProviders();
  const status = threadProviderStatus(providers, thread);
  const acceptsImages = status === undefined || status.caps.images;
  const followUp = useFollowUp(thread.id, status?.caps.steer === true);
  const running = thread.status === "running";
  const interrupting = thread.interrupting === true;
  const matches = useMentionMatches(thread.id, mention?.query, thread.projectId);
  const listsCommands = status?.caps.commands === true;
  const slash = useSlash(thread, text, listsCommands, scope === "main");
  const harness = useThreadHarnessLabel(thread);
  const files = fileAttachments.files;
  const { send: sendNow, busy, uploading } = useComposerSend({
    thread,
    text,
    images: attachments.images,
    files,
    followUp,
    onSent: () => {
      draft.clear();
      attachments.clear();
    },
  });

  useEffect(() => (scope === "main" ? registerComposerFocus(() => input.current?.focus()) : undefined), [scope]);

  useComposeEvent(thread.id, scope, (detail) => {
    const next = applyCompose(getDraft(thread.id)?.text ?? "", detail);
    setText(next);
    setMention(undefined);
    slash.close();
    placeCaret(next.length);
  });
  useEscInterrupt(root, thread.id, scope, running && !interrupting);

  const send = async (...args: Parameters<typeof sendNow>): Promise<void> => {
    if (!interceptSide(thread, scope, text, attachments.images.length + files.length > 0, () => setText(""))) await sendNow(...args);
  };

  /** Images ride inline when the harness takes them; everything else is uploaded on send. */
  const attach = (picked: File[]): void => {
    if (picked.length === 0) return;
    const split = splitFiles(picked, acceptsImages);
    if (split.images.length > 0) void attachments.add(split.images);
    fileAttachments.add(split.files);
  };

  /** Drops `@thread:<id> ` at the caret (rail drag, picker). */
  const insertThread = (id: string): void => {
    if (threadMentionIds(text).includes(id)) return;
    const caret = input.current?.selectionStart ?? text.length;
    const next = insertAt(text, caret, threadMention(id));
    setText(next.text);
    placeCaret(next.caret);
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

  const pick = (item: MentionItem | undefined): void => {
    if (!mention || !item) return;
    const token = item.kind === "file" ? item.path : `${THREAD_PREFIX}${item.id}`;
    const next = applyMention(text, mention, mention.caret, token);
    setText(next.text);
    setMention(undefined);
    placeCaret(next.caret);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (mention && matches.items.length > 0) {
      if (e.key === "ArrowDown") setCursor((v) => Math.min(matches.items.length - 1, v + 1));
      else if (e.key === "ArrowUp") setCursor((v) => Math.max(0, v - 1));
      else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) pick(matches.items[cursor]);
      else if (e.key === "Tab") pick(matches.items[cursor]);
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
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    // ↵ / ⌘↵ send and stay (running: in the selected follow-up mode); ⇧↵ newline;
    // ⌥↵ the other follow-up mode; ⌘⇧↵ send and go back to Mission Control.
    if (e.shiftKey && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    if (e.altKey) void send(running ? followUp.alternate : undefined);
    else if (e.shiftKey) void send(running ? followUp.mode : undefined, !running);
    else void send(running ? followUp.mode : undefined);
  };

  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, text.split("\n").length));
  const nothingToSend = text.trim() === "" && attachments.images.length === 0 && files.length === 0;
  const primaryLabel = uploading > 0 ? "Uploading…" : !running ? "Send" : followUp.mode === "steer" ? "Steer" : "Queue";

  return (
    <div
      className={styles.composer}
      ref={root}
      {...(dropping ? { "data-dropping": "" } : {})}
      onDragOver={(e) => {
        const types = e.dataTransfer?.types ?? [];
        if (types.includes(THREAD_DRAG_TYPE) || transferHasFiles(e.dataTransfer)) {
          e.preventDefault();
          if (!dropping && transferHasFiles(e.dataTransfer)) setDropping(true);
        }
      }}
      onDragLeave={(e) => {
        // leaving the island itself, not moving between its children
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
      }}
      onDrop={(e) => {
        setDropping(false);
        // a rail thread becomes an @thread mention
        const threadId = e.dataTransfer?.getData(THREAD_DRAG_TYPE) ?? "";
        if (threadId !== "") {
          e.preventDefault();
          if (threadId !== thread.id) insertThread(threadId);
          return;
        }
        // any file: never let the browser navigate to it; images vs files is decided in attach
        if (!transferHasFiles(e.dataTransfer)) return;
        e.preventDefault();
        attach(filesOf(e.dataTransfer));
      }}
    >
      {mention ? <MentionPicker matches={matches} cursor={cursor} onPick={pick} /> : null}
      {!mention && slash.query ? <SlashPicker slash={slash} cursor={cursor} onPick={pickCommand} /> : null}
      <AttachmentStrip images={attachments.images} onRemove={attachments.remove} />
      <FileChips files={files} onRemove={fileAttachments.remove} />
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
          const pastedFiles = filesOf(e.clipboardData);
          if (pastedFiles.length > 0) {
            e.preventDefault();
            attach(pastedFiles);
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
      <ThreadContextChips text={text} onChange={setText} />
      {slash.unknown === undefined ? null : (
        <p className={styles.switchHint} role="status">
          Unknown command for {harness}; it will be sent as text
        </p>
      )}
      <div className={styles.settings} data-composer-pills>
        <ThreadPills thread={thread} />
        <ThreadLinkChips threadId={thread.id} />
      </div>
      <div className={styles.actions}>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="Attach files"
          onChange={(e) => {
            attach(Array.from(e.currentTarget.files ?? []));
            e.currentTarget.value = "";
          }}
        />
        <Button variant="quiet" title="Attach files" aria-label="Attach files…" onClick={() => picker.current?.click()}>
          📎
        </Button>
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
          {uploading > 0 ? (
            <span role="status">Uploading {uploading === 1 ? "1 file" : `${uploading} files`}…</span>
          ) : interrupting ? (
            <span className={styles.interrupting}>interrupting…</span>
          ) : (
            <>
              <Kbd>↵</Kbd> {running ? followUp.mode : "send"}
              {running && followUp.canSteer ? (
                <>
                  {" · "}
                  <Kbd>⌥↵</Kbd> {followUp.alternate}
                </>
              ) : null}
              {running ? null : (
                <>
                  {" · "}
                  <Kbd>⌘⇧↵</Kbd> send in background
                </>
              )}
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
          <Button variant="primary" onClick={() => void send()} disabled={busy || nothingToSend}>
            {primaryLabel}
          </Button>
        </span>
      </div>
      <ProviderSwitchHint thread={thread} />
    </div>
  );
}
