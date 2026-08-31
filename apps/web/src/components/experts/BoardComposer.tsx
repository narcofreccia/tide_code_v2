import { useState } from "react";
import type { ExpertsSession } from "@tide/contracts";
import { postToPanel } from "../../lib/expertsActions.ts";
import { Button } from "../ui/Button.tsx";
import { Select } from "../ui/Select.tsx";
import { recipientOptions } from "./labels.ts";
import styles from "./Board.module.css";

/** The user is a participant, not a spectator: their post reaches the panel. */
export function BoardComposer({ session }: { session: ExpertsSession }) {
  const [text, setText] = useState("");
  const [to, setTo] = useState("all");

  const send = (): void => {
    const trimmed = text.trim();
    if (trimmed === "") return;
    postToPanel(session.id, trimmed, to);
    setText("");
  };

  return (
    <div className={styles.composer}>
      <textarea
        className={styles.textarea}
        aria-label="Post to the panel"
        placeholder="Post to the panel…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== "Enter" || !(e.metaKey || e.ctrlKey)) return;
          e.preventDefault();
          send();
        }}
      />
      <div className={styles.composerBar}>
        <Select label="Post to" value={to} options={recipientOptions(session)} onSelect={setTo} />
        <Button variant="primary" disabled={text.trim() === ""} onClick={send}>
          Post
        </Button>
      </div>
    </div>
  );
}
