import { useEffect, useState } from "react";
import type { Thread } from "@tide/contracts";
import { useLatestTurnStatus } from "../../state/hooks.ts";
import {
  archiveThread,
  copyTerminalCommand,
  createThread,
  fetchTerminalCommand,
} from "../../lib/threadActions.ts";
import { DelegatedBy, DelegatesPopover } from "./Delegates.tsx";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { StatusGlyph } from "../ui/StatusGlyph.tsx";
import { PrBadge } from "../ui/VcsBadges.tsx";
import styles from "./ThreadHeader.module.css";

const NO_COMMAND = "No harness session to resume yet";

/** Resolves the harness's own resume command; undefined until the session exists. */
function useTerminalCommand(threadId: string, nativeSessionId: string | undefined): string | undefined {
  const [command, setCommand] = useState<string | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    fetchTerminalCommand(threadId)
      .then((value) => {
        if (alive) setCommand(value);
      })
      .catch(() => {
        if (alive) setCommand(undefined);
      });
    return () => {
      alive = false;
    };
  }, [threadId, nativeSessionId]);
  return command;
}

export function ThreadHeader({ thread }: { thread: Thread }) {
  const turnStatus = useLatestTurnStatus(thread);
  const command = useTerminalCommand(thread.id, thread.nativeSessionId);
  const context = thread.contextUsage;
  const percent = context && context.window > 0 ? Math.round((context.used / context.window) * 100) : undefined;

  return (
    <header className={styles.header}>
      <StatusGlyph status={thread.status} {...(thread.attention ? { attention: thread.attention } : {})} />
      <span className={styles.branch} title={thread.worktreePath ?? "no worktree"}>
        {thread.worktreePath === undefined ? "" : "⎇ "}
        {thread.branch ?? "no worktree"}
      </span>
      {thread.pr ? <PrBadge pr={thread.pr} /> : null}
      {thread.delegatedBy ? <DelegatedBy parentThreadId={thread.delegatedBy} /> : null}
      <DelegatesPopover threadId={thread.id} />
      <Pill>{turnStatus ?? thread.status}</Pill>
      {percent === undefined ? null : <span className={styles.stat}>ctx {percent}%</span>}
      {thread.totalCostUsd === undefined ? null : (
        <span className={styles.stat}>${thread.totalCostUsd.toFixed(2)}</span>
      )}
      <div className={styles.actions}>
        <Button
          variant="quiet"
          disabled={command === undefined}
          title={command ?? NO_COMMAND}
          onClick={() => {
            if (command) void copyTerminalCommand(command);
          }}
        >
          Open in terminal
        </Button>
        <Button
          variant="quiet"
          onClick={() => void createThread(thread.projectId, thread.provider, { parentThreadId: thread.id })}
          title="New child thread"
        >
          + child
        </Button>
        <Button variant="quiet" onClick={() => archiveThread(thread.id)}>
          Archive
        </Button>
      </div>
    </header>
  );
}
