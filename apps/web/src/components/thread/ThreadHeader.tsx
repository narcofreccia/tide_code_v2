import { useEffect, useState } from "react";
import { selectDelegates } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { fetchTerminalCommand, interruptTurn } from "../../lib/threadActions.ts";
import { runInThreadTerminal } from "../../lib/openInTerminal.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { latestSettledTurnId } from "../shell/railMenus.ts";
import { LimitedBadge, LineageChip, RollbackPill } from "./ThreadChips.tsx";
import { DelegatedBy, DelegatesPopover } from "./Delegates.tsx";
import { headerMenu } from "./headerMenu.ts";
import { TeamStrip } from "./TeamStrip.tsx";
import { ThreadTitle } from "./ThreadTitle.tsx";
import { Button } from "../ui/Button.tsx";
import { ContextMenu, type MenuPosition } from "../ui/Menu.tsx";
import { RateLimitBadge } from "../ui/RateLimitBadge.tsx";
import { StateGlyph } from "../ui/StatusGlyph.tsx";
import { MergeGlyph, PrBadge } from "../ui/VcsBadges.tsx";
import { threadStateKey, threadStateLabel } from "../../lib/vocab.ts";
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

/** The sub-row exists only when at least one of these has something to say. */
function hasChips(thread: Thread, delegates: number): boolean {
  return (
    thread.pr !== undefined ||
    thread.merge !== undefined ||
    thread.mergedAt !== undefined ||
    thread.delegatedBy !== undefined ||
    delegates > 0 ||
    thread.forkedFrom !== undefined ||
    thread.limited !== undefined ||
    (thread.rollback !== undefined && thread.rollback.status !== "done") ||
    (thread.rateLimit !== undefined && thread.rateLimit.status !== "ok")
  );
}

/**
 * One 32px row: state · title · branch on the left; Stop (only while running),
 * Terminal, Fork and `⋯` on the right. Lineage, limits, rollback and delegates
 * get a 24px sub-row that is absent when there is nothing to show.
 */
export function ThreadHeader({ thread }: { thread: Thread }) {
  const command = useTerminalCommand(thread.id, thread.nativeSessionId);
  const state = threadStateKey(thread);
  const word = threadStateLabel(thread);
  const forkTurn = useModel((s) => latestSettledTurnId(s.model, thread.id));
  const delegates = useModel((s) => selectDelegates(s.model, thread.id).length);
  const [menu, setMenu] = useState<MenuPosition | undefined>(undefined);
  const running = thread.status === "running";

  return (
    <header className={styles.header}>
      <div className={styles.main}>
        <span className={styles.state} data-state={state} title={word}>
          <StateGlyph state={state} />
          {word}
        </span>
        <ThreadTitle thread={thread} />
        <span
          className={styles.branch}
          title={thread.worktreePath ?? "Runs in the project's main checkout"}
        >
          {thread.worktreePath === undefined ? "" : "⎇ "}
          {thread.branch ?? "main checkout"}
        </span>
        <div className={styles.actions}>
          {running ? (
            <Button
              variant="danger"
              disabled={thread.interrupting === true}
              title="Stop the running turn (Esc)"
              onClick={() => interruptTurn(thread.id)}
            >
              Stop
            </Button>
          ) : null}
          <Button
            variant="quiet"
            disabled={command === undefined}
            title={command ? `Open in terminal: ${command}` : NO_COMMAND}
            onClick={() => {
              if (command) void runInThreadTerminal(thread.id, command);
            }}
          >
            Terminal
          </Button>
          <Button
            variant="quiet"
            disabled={forkTurn === undefined}
            title={forkTurn === undefined ? "No finished turn to fork from" : "Fork from the latest finished turn"}
            onClick={() => {
              if (forkTurn) useUi.getState().setThreadDialog({ kind: "fork", threadId: thread.id, turnId: forkTurn });
            }}
          >
            Fork
          </Button>
          <Button
            variant="quiet"
            title="More actions"
            aria-label="More actions"
            aria-haspopup="menu"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setMenu({ x: rect.left, y: rect.bottom });
            }}
          >
            ⋯
          </Button>
        </div>
      </div>
      {hasChips(thread, delegates) ? (
        <div className={styles.sub}>
          {thread.pr ? <PrBadge pr={thread.pr} /> : null}
          <MergeGlyph thread={thread} />
          {thread.delegatedBy ? <DelegatedBy parentThreadId={thread.delegatedBy} /> : null}
          <DelegatesPopover threadId={thread.id} />
          <LineageChip thread={thread} />
          <LimitedBadge thread={thread} />
          <RollbackPill thread={thread} />
          <RateLimitBadge limit={thread.rateLimit} />
        </div>
      ) : null}
      {thread.team ? <TeamStrip thread={thread} /> : null}
      {menu ? (
        <ContextMenu
          position={menu}
          items={headerMenu(useModel.getState().model, thread)}
          onClose={() => setMenu(undefined)}
          label="Thread actions"
        />
      ) : null}
    </header>
  );
}
