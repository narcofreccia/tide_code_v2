import { useEffect, useRef, useState } from "react";
import { selectDelegates, selectLatestSettledTurnId, selectQuotaHold } from "@tide/client";
import type { Thread } from "@tide/contracts";
import { fetchTerminalCommand } from "../../lib/threadActions.ts";
import { runInThreadTerminal } from "../../lib/openInTerminal.ts";
import { useModel } from "../../state/model.ts";
import { useThreadDeviceLimit } from "../../state/deviceAccess.ts";
import { useUi } from "../../state/ui.ts";
import { LimitedBadge, LineageChip, RollbackPill } from "./ThreadChips.tsx";
import { DelegatedBy, DelegatesPopover } from "./Delegates.tsx";
import { SideChatsPopover, selectSideChats } from "./SideChatsList.tsx";
import { headerMenu } from "./headerMenu.ts";
import { TeamStrip } from "./TeamStrip.tsx";
import { ThreadTitle } from "./ThreadTitle.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { ContextMenu, type MenuPosition } from "../ui/Menu.tsx";
import { RateLimitBadge } from "../ui/RateLimitBadge.tsx";
import { StateGlyph } from "../ui/StatusGlyph.tsx";
import { MergeGlyph, PrBadge } from "../ui/VcsBadges.tsx";
import { MergeErrorNotice } from "../workbench/MergeAction.tsx";
import { threadStateKey, threadStateLabel } from "../../lib/vocab.ts";
import { useBackgroundAgentCount } from "../../state/hooks.ts";
import { useThreadEnvStatus } from "../../state/threadEnv.ts";
import { Pill } from "../ui/Pill.tsx";
import { LiveLabel } from "./LiveLabel.tsx";
import { QuotaChip } from "../quota/QuotaMeter.tsx";
import { useTicker } from "../mission/useTicker.ts";
import styles from "./ThreadHeader.module.css";

/** Below this container width Terminal and Fork fold into the More menu. */
export const NARROW_PX = 560;

function useNarrow(ref: React.RefObject<HTMLElement | null>): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? el.clientWidth;
      setNarrow(width > 0 && width < NARROW_PX);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return narrow;
}

const NO_COMMAND = "No harness session to resume yet";

/**
 * Resolves the harness's own resume command; undefined until the session exists. Not asked for
 * while this device is limited there (the server refuses it); asked again once that lifts.
 */
function useTerminalCommand(threadId: string, nativeSessionId: string | undefined, limited: boolean): string | undefined {
  const [command, setCommand] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (limited) {
      setCommand(undefined);
      return;
    }
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
  }, [threadId, nativeSessionId, limited]);
  return command;
}

/** The sub-row exists only when at least one of these has something to say. */
function hasChips(thread: Thread, delegates: number, held: boolean): boolean {
  return (
    held ||
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
 * One 32px row: state · title · branch on the left; Terminal, Fork and More on the right
 * (Terminal and Fork fold into More when narrow; Stop lives in the composer). Lineage, limits, rollback and delegates
 * get a 24px sub-row that is absent when there is nothing to show.
 */
export function ThreadHeader({ thread }: { thread: Thread }) {
  // R19: a terminal is a shell on the host, full access only
  const limit = useThreadDeviceLimit(thread.id);
  const command = useTerminalCommand(thread.id, thread.nativeSessionId, limit !== undefined);
  const background = useBackgroundAgentCount(thread.id);
  // a limit reset or a quota window passing is no event: tick while either can happen
  useTicker(thread.limited !== undefined ? 30_000 : 0);
  const now = Date.now();
  const limits = useModel((s) => s.model.limits);
  const state = threadStateKey(thread, now, background);
  const word = threadStateLabel(thread, now, background, limits === undefined ? undefined : { limits });
  // quotas live on threads and projects: re-render on those maps, read the rest of the model as is
  useModel((s) => s.model.threads);
  useModel((s) => s.model.projects);
  const held = selectQuotaHold(useModel.getState().model, thread, now);
  const forkTurn = useModel((s) => selectLatestSettledTurnId(s.model, thread.id));
  const delegates = useModel((s) => selectDelegates(s.model, thread.id).length + selectSideChats(s.model, thread.id).length);
  const [menu, setMenu] = useState<MenuPosition | undefined>(undefined);
  const mainRef = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(mainRef);
  // the primary's drops have the app-wide banner; another machine's say so here
  const env = useThreadEnvStatus(thread.id);
  const machineOffline = !env.online && !env.primary;

  return (
    <header className={styles.header}>
      <div className={styles.main} ref={mainRef}>
        <span className={styles.state} data-state={state} title={word}>
          <StateGlyph state={state} />
          {state === "background" ? <LiveLabel text={word} className={styles.liveWord} /> : word}
        </span>
        <ThreadTitle thread={thread} live={state === "running" || state === "background"} />
        <span
          className={styles.branch}
          title={thread.worktreePath ?? "Runs in the project's main checkout"}
        >
          {thread.worktreePath === undefined ? null : <Icon name="branch" size={12} className={`${styles.branchIcon}`} />}
          <span className={styles.branchName}>{thread.branch ?? "main checkout"}</span>
        </span>
        {machineOffline ? (
          <Pill tone="interrupted" size="sm" className={styles.offline} title="Its last known state; nothing can be sent until it reconnects">
            {env.machine} is offline
          </Pill>
        ) : null}
        <div className={styles.actions}>
          {narrow ? null : (
            <>
          <Button
            variant="quiet"
            disabled={command === undefined || limit !== undefined}
            title={
              limit ??
              (command ? `Open in terminal: ${command}` : thread.nativeSessionId === undefined ? NO_COMMAND : "This harness has no terminal resume command")
            }
            onClick={() => {
              if (command) void runInThreadTerminal(thread.id, command, { purpose: "resume" });
            }}
          >
            <Icon name="terminal" size={14} />
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
            <Icon name="branch" size={14} />
            Fork
          </Button>
            </>
          )}
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
            <Icon name="more" />
          </Button>
        </div>
      </div>
      {hasChips(thread, delegates, held !== undefined) ? (
        <div className={styles.sub}>
          {thread.pr ? <PrBadge pr={thread.pr} /> : null}
          <MergeGlyph thread={thread} />
          <MergeErrorNotice thread={thread} />
          {thread.delegatedBy ? <DelegatedBy parentThreadId={thread.delegatedBy} /> : null}
          <DelegatesPopover threadId={thread.id} />
          <SideChatsPopover threadId={thread.id} />
          <LineageChip thread={thread} />
          <LimitedBadge thread={thread} />
          {held === undefined ? null : <QuotaChip view={held} />}
          <RollbackPill thread={thread} />
          <RateLimitBadge limit={thread.rateLimit} />
        </div>
      ) : null}
      {thread.team ? <TeamStrip thread={thread} /> : null}
      {menu ? (
        <ContextMenu
          position={menu}
          items={headerMenu(useModel.getState().model, thread, Date.now(), narrow ? { terminal: command, fork: forkTurn } : undefined)}
          onClose={() => setMenu(undefined)}
          label="Thread actions"
        />
      ) : null}
    </header>
  );
}
