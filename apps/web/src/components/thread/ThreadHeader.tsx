import { useEffect, useState } from "react";
import type { Thread } from "@tide/contracts";
import { useLatestTurnStatus } from "../../state/hooks.ts";
import { createThread, fetchTerminalCommand, requestArchive } from "../../lib/threadActions.ts";
import { runInThreadTerminal } from "../../lib/openInTerminal.ts";
import { useUi } from "../../state/ui.ts";
import { DelegatedBy, DelegatesPopover } from "./Delegates.tsx";
import { Button } from "../ui/Button.tsx";
import { Pill } from "../ui/Pill.tsx";
import { Popover } from "../ui/Popover.tsx";
import { RateLimitBadge } from "../ui/RateLimitBadge.tsx";
import { ThreadGlyph } from "../ui/StatusGlyph.tsx";
import { MergeGlyph, PrBadge } from "../ui/VcsBadges.tsx";
import { contextTitle } from "../../lib/glassBox.ts";
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
      <ThreadGlyph thread={thread} />
      <span className={styles.branch} title={thread.worktreePath ?? "no worktree"}>
        {thread.worktreePath === undefined ? "" : "⎇ "}
        {thread.branch ?? "no worktree"}
      </span>
      {thread.pr ? <PrBadge pr={thread.pr} /> : null}
      <MergeGlyph thread={thread} />
      {thread.delegatedBy ? <DelegatedBy parentThreadId={thread.delegatedBy} /> : null}
      <DelegatesPopover threadId={thread.id} />
      <Pill>{thread.interrupting === true ? "interrupting…" : (turnStatus ?? thread.status)}</Pill>
      {percent === undefined || !context ? null : (
        <span className={styles.stat} title={contextTitle(context)}>
          ctx {percent}%
        </span>
      )}
      {thread.totalCostUsd === undefined ? null : (
        <span className={styles.stat}>${thread.totalCostUsd.toFixed(2)}</span>
      )}
      <RateLimitBadge limit={thread.rateLimit} />
      <div className={styles.actions}>
        <Button
          variant="quiet"
          disabled={command === undefined}
          title={command ?? NO_COMMAND}
          onClick={() => {
            if (command) void runInThreadTerminal(thread.id, command);
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
        <Button variant="quiet" onClick={() => requestArchive(thread)}>
          Archive
        </Button>
        <Popover label="⋯" title="More actions" align="end" variant="quiet">
          {(close) => (
            <div className={styles.menu}>
              <Button
                variant="quiet"
                disabled={thread.worktreePath === undefined}
                title={thread.worktreePath ?? "This thread has no worktree"}
                onClick={() => {
                  close();
                  useUi.getState().setThreadDialog({ kind: "detach", threadId: thread.id });
                }}
              >
                Detach worktree…
              </Button>
            </div>
          )}
        </Popover>
      </div>
    </header>
  );
}
