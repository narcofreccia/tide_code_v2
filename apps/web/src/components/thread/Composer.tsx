import { useEffect, useRef, useState } from "react";
import type { Thread } from "@tide/contracts";
import { interruptTurn, sendTurn } from "../../lib/threadActions.ts";
import { registerComposerFocus } from "../../lib/composerFocus.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { ThreadPills } from "./ThreadPills.tsx";
import styles from "./Composer.module.css";

const MIN_ROWS = 3;
const MAX_ROWS = 8;

export function Composer({ thread }: { thread: Thread }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const running = thread.status === "running";

  useEffect(() => registerComposerFocus(() => input.current?.focus()), []);

  useEffect(() => {
    if (!running) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      interruptTurn(thread.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [running, thread.id]);

  const send = (): void => {
    const value = text.trim();
    if (!value || busy || running) return;
    setBusy(true);
    sendTurn(thread.id, value)
      .then(() => setText(""))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, text.split("\n").length));

  return (
    <div className={styles.composer}>
      <textarea
        ref={input}
        className={styles.input}
        aria-label="Message"
        placeholder="Ask the agent…"
        rows={rows}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className={styles.actions}>
        <ThreadPills thread={thread} />
        <span className={styles.hint}>
          <Kbd>{running ? "Esc" : "⌘↵"}</Kbd> {running ? "stop" : "send"}
        </span>
        {running ? (
          <Button variant="primary" onClick={() => interruptTurn(thread.id)}>
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
