import { useState } from "react";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import styles from "./Composer.module.css";

export function Composer({ onSend }: { onSend: (text: string) => Promise<void> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const send = (): void => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    onSend(value)
      .then(() => setText(""))
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <div className={styles.composer}>
      <textarea
        className={styles.input}
        aria-label="Message"
        placeholder="Ask the agent…"
        rows={3}
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
        <span className={styles.hint}>
          <Kbd>⌘↵</Kbd> send
        </span>
        <Button variant="primary" onClick={send} disabled={busy || text.trim() === ""}>
          Send
        </Button>
      </div>
    </div>
  );
}
