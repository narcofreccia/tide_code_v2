import { useEffect, useRef, useState } from "react";
import type { Thread } from "@tide/contracts";
import { interruptTurn, sendTurn } from "../../lib/threadActions.ts";
import { registerComposerFocus } from "../../lib/composerFocus.ts";
import { applyMention, expandMentions, findMentionQuery, normalizePastedPath } from "../../lib/mentions.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { MentionPicker, useMentionMatches } from "./MentionPicker.tsx";
import { ThreadPills } from "./ThreadPills.tsx";
import styles from "./Composer.module.css";

const MIN_ROWS = 3;
const MAX_ROWS = 8;

export function Composer({ thread }: { thread: Thread }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string; caret: number } | undefined>(undefined);
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const running = thread.status === "running";
  const interrupting = thread.interrupting === true;
  const matches = useMentionMatches(thread.id, mention?.query);

  useEffect(() => registerComposerFocus(() => input.current?.focus()), []);

  useEffect(() => {
    if (!running || interrupting) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      interruptTurn(thread.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, interrupting, thread.id]);

  const sync = (value: string, caret: number): void => {
    setText(value);
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

  const send = (): void => {
    const value = text.trim();
    if (!value || busy || running) return;
    setBusy(true);
    sendTurn(thread.id, expandMentions(value))
      .then(() => setText(""))
      .catch(() => undefined)
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

  return (
    <div className={styles.composer}>
      {mention ? <MentionPicker matches={matches} cursor={cursor} onPick={pick} /> : null}
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
        <span className={styles.hint}>
          {interrupting ? (
            <span className={styles.interrupting}>interrupting…</span>
          ) : (
            <>
              <Kbd>{running ? "Esc" : "⌘↵"}</Kbd> {running ? "stop" : "send"}
            </>
          )}
        </span>
        {running ? (
          <Button variant="primary" disabled={interrupting} onClick={() => interruptTurn(thread.id)}>
            Stop
          </Button>
        ) : (
          <Button variant="primary" onClick={send} disabled={busy || text.trim() === ""}>
            Send
          </Button>
        )}
      </div>
    </div>
  );
}
