import { useState } from "react";
import type { Thread } from "@tide/contracts";
import { settleThread, unsettleThread, updateThread } from "../../lib/threadActions.ts";
import { isThreadMerged } from "@tide/client";
import { relativeTime } from "../../lib/relativeTime.ts";
import { PROVIDER_MONOGRAMS, threadStateKey } from "../../lib/vocab.ts";
import { useThreadHarnessLabel } from "../../state/providers.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { activityCount, isUnread, useLastSeen } from "../../state/lastSeen.ts";
import { selectRailRange, setRailAnchor, toggleRailSelected, useRailSelection } from "../../state/railSelection.ts";
import { ContextMenu, type MenuItem, type MenuPosition } from "../ui/Menu.tsx";
import { ThreadGlyph } from "../ui/StatusGlyph.tsx";
import { MergeGlyph, PrGlyph } from "../ui/VcsBadges.tsx";
import { threadMenu } from "./railMenus.ts";
import styles from "./ProjectTree.module.css";

const ROLE_GLYPH: Record<NonNullable<Thread["role"]>, string> = {
  expert: "◆",
  lead: "★",
  delegate: "↳",
};

/** Rail tags stay short; the tooltip carries the full role. */
/** delegate outcomes the rail paints as a problem */
const BAD_LABELS = new Set(["failed", "blocked", "fail"]);

export function truncateRole(role: string): string {
  return role.length > 12 ? `${role.slice(0, 11)}…` : role;
}

/** Delegation wins over the ordinary parent link, so a delegate nests under its caller. */
export function parentOf(thread: Thread): string | undefined {
  return thread.delegatedBy ?? thread.parentThreadId;
}

/** The muted tag a settled row carries: why it left the inbox. */
export const SETTLE_TAGS: Record<NonNullable<Thread["settleReason"]>, string> = {
  user: "settled",
  "pr-merged": "merged",
  "merged-back": "merged",
  inactive: "inactive",
};

/** Thread ids of the rail's rows in visible order: what a shift-click range spans. */
function visibleOrder(from: HTMLElement): string[] {
  const root: ParentNode = from.closest("nav") ?? document;
  const ids = Array.from(root.querySelectorAll<HTMLElement>("[data-rail-thread]")).map((n) => n.dataset.railThread ?? "");
  return [...new Set(ids.filter((id) => id !== ""))];
}

/** Inline rename: Enter saves through `thread.update`, Esc (or leaving the field) cancels. */
function RenameField({ thread, onDone }: { thread: Thread; onDone: () => void }) {
  const [value, setValue] = useState(thread.title);
  return (
    <input
      className={styles.rename}
      aria-label="Thread title"
      autoFocus
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={onDone}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          const title = value.trim();
          if (title !== "" && title !== thread.title) updateThread(thread.id, { title });
          onDone();
        } else if (e.key === "Escape") {
          // the composer would otherwise read this Escape as "stop the turn"
          e.preventDefault();
          e.stopPropagation();
          e.nativeEvent.stopImmediatePropagation();
          onDone();
        }
      }}
    />
  );
}

/** A rail thread row with right-click and hover `⋯` menus; children nest below it. */
export function RailThreadRow({ thread, siblings }: { thread: Thread; siblings: readonly Thread[] }) {
  const active = useUi((s) => s.view === "thread" && s.selectedThreadId === thread.id);
  const selectThread = useUi((s) => s.selectThread);
  const picked = useRailSelection((s) => s.ids.includes(thread.id));
  const count = useModel((s) => activityCount(s.model, thread.id));
  const selectedId = useUi((s) => (s.view === "thread" ? s.selectedThreadId : null));
  const unread = useLastSeen((s) => isUnread(thread, count, s, selectedId));
  const settled = thread.settledAt !== undefined;
  const [menu, setMenu] = useState<{ at: MenuPosition; items: MenuItem[] } | undefined>(undefined);
  const [renaming, setRenaming] = useState(false);
  const low = useServerSettings((s) => s.settings.decisions.grayZone.low);
  const j = thread.judge;
  const judge = thread.delegatedBy !== undefined && thread.status !== "running" && j?.label !== undefined && j.confidence >= low ? { label: j.label, source: j.source, confidence: j.confidence } : undefined;
  const children = siblings.filter((t) => parentOf(t) === thread.id);
  const archived = thread.archivedAt !== undefined;
  const state = threadStateKey(thread);
  const loud = state === "needs" || state === "running";
  const hasVcs = thread.pr !== undefined || thread.merge !== undefined || isThreadMerged(thread);
  const harness = useThreadHarnessLabel(thread);
  const tip = [
    `${PROVIDER_MONOGRAMS[thread.provider]} · ${harness}`,
    thread.worktreePath === undefined ? undefined : `worktree ${thread.worktreePath}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const openMenu = (at: MenuPosition): void =>
    setMenu({ at, items: threadMenu(useModel.getState().model, thread, () => setRenaming(true)) });

  return (
    <li>
      <div
        className={[
          styles.row,
          styles.threadRow,
          active ? styles.active : "",
          picked ? styles.picked : "",
          archived ? styles.archived : "",
          state === "needs" ? styles.needsRow : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-rail-thread={thread.id}
        onContextMenu={(e) => {
          e.preventDefault();
          openMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        {renaming ? (
          <RenameField thread={thread} onDone={() => setRenaming(false)} />
        ) : (
          <button
            type="button"
            className={styles.thread}
            title={tip}
            aria-pressed={picked ? true : undefined}
            onClick={(e) => {
              if (e.shiftKey) {
                selectRailRange(thread.id, visibleOrder(e.currentTarget));
                return;
              }
              if (e.metaKey || e.ctrlKey) {
                toggleRailSelected(thread.id);
                return;
              }
              setRailAnchor(thread.id);
              selectThread(thread.id);
            }}
          >
            <ThreadGlyph thread={thread} />
            {thread.role ? (
              <span className={styles.roleGlyph} title={thread.role} aria-label={thread.role} role="img">
                {ROLE_GLYPH[thread.role]}
              </span>
            ) : null}
            {thread.team ? (
              <span className={styles.roleGlyph} title={`Team run: ${thread.team.name}`} aria-label="team" role="img">
                ⛓
              </span>
            ) : null}
            <span className={`${styles.threadTitle} ${loud ? styles.loud : ""}`}>{thread.title}</span>
            {thread.pinned && !archived ? (
              <span className={styles.pinMark} title="Pinned" aria-label="pinned" role="img">
                📌
              </span>
            ) : null}
            {thread.delegateRole ? (
              <span className={styles.roleTag} title={`Role: ${thread.delegateRole}`}>
                {truncateRole(thread.delegateRole)}
              </span>
            ) : null}
            {judge ? (
              <span className={`${styles.roleTag} ${BAD_LABELS.has(judge.label) ? styles.badTag : ""}`} title={`Judge: ${judge.source} ${judge.confidence.toFixed(2)}`}>
                {judge.label}
              </span>
            ) : null}
            {settled && thread.settleReason ? (
              <span className={styles.settleTag} title="Settled: out of the inbox, worktree kept">
                {SETTLE_TAGS[thread.settleReason]}
              </span>
            ) : null}
            {unread ? <span className={styles.unread} aria-label="unread" role="img" title="New activity" /> : null}
            <span className={styles.meta}>
              {hasVcs ? (
                <>
                  <PrGlyph pr={thread.pr} />
                  <MergeGlyph thread={thread} />
                </>
              ) : (
                <span className={styles.time}>{relativeTime(thread.updatedAt)}</span>
              )}
            </span>
          </button>
        )}
        {archived ? null : (
          <button
            type="button"
            className={`${styles.settle} ${settled ? styles.settleOn : ""}`}
            aria-label={settled ? `Unsettle ${thread.title}` : `Settle ${thread.title}`}
            title={settled ? "Unsettle: back to the inbox" : "Settle: close from the inbox, worktree kept (⌘Z undoes)"}
            onClick={() => (settled ? unsettleThread(thread.id) : settleThread(thread.id))}
          >
            {settled ? "✓" : ""}
          </button>
        )}
        <button
          type="button"
          className={styles.more}
          aria-label={`Actions for ${thread.title}`}
          title="More actions"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            openMenu({ x: rect.left, y: rect.bottom });
          }}
        >
          ⋯
        </button>
      </div>
      {menu ? (
        <ContextMenu position={menu.at} items={menu.items} onClose={() => setMenu(undefined)} label="Thread actions" />
      ) : null}
      {children.length > 0 ? (
        <ul className={styles.threads}>
          {children.map((c) => (
            <RailThreadRow key={c.id} thread={c} siblings={siblings} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}
