import { memo, useEffect, useMemo, useRef, useState } from "react";
import { THREAD_DRAG_TYPE } from "../../lib/mentions.ts";
import type { Thread } from "@tide/contracts";
import { canMergeBack, mergeBackThread, settleThread, unsettleThread, updateThread } from "../../lib/threadActions.ts";
import { isThreadMerged } from "@tide/client";
import type { SearchHit } from "@tide/contracts";
import { relativeTime, relativeUntil } from "../../lib/relativeTime.ts";
import { PROVIDER_MONOGRAMS, backgroundAgentsTip, threadStateKey } from "../../lib/vocab.ts";
import { useBackgroundAgentCount } from "../../state/hooks.ts";
import { useThreadHarnessLabel } from "../../state/providers.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { activityCount, isUnread, useLastSeen } from "../../state/lastSeen.ts";
import {
  requestRailSnooze,
  selectRailRange,
  setRailAnchor,
  toggleRailSelected,
  useRailMenuRequest,
  useRailSelection,
} from "../../state/railSelection.ts";
import { ContextMenu, type MenuItem, type MenuPosition } from "../ui/Menu.tsx";
import { ThreadGlyph } from "../ui/StatusGlyph.tsx";
import { MergeGlyph } from "../ui/VcsBadges.tsx";
import { Icon } from "../ui/Icon.tsx";
import { firstGrapheme } from "../ui/ProjectIcon.tsx";
import { snoozeItems, threadMenu } from "./railMenus.ts";
import { liveLabelFor, liveLabelKey, parseLiveLabelKey } from "../../lib/liveLabel.ts";
import { RailLiveLine, recedes } from "./RailLiveLine.tsx";
import { NO_NODES, childNodesIn, parentOf, type RailNode } from "./railTree.ts";
import { RailHoverCard } from "./RailHoverCard.tsx";
import styles from "./RailThreadRow.module.css";

const ROLE_GLYPH: Record<NonNullable<Thread["role"]>, string> = {
  expert: "◆",
  lead: "★",
  delegate: "↳",
  side: "⋯",
};

/** Rail tags stay short; the tooltip carries the full role. */
/** delegate outcomes the rail paints as a problem */
const BAD_LABELS = new Set(["failed", "blocked", "fail"]);

export function truncateRole(role: string): string {
  return role.length > 12 ? `${role.slice(0, 11)}…` : role;
}

export { parentOf };

/** The muted tag a settled row carries: why it left the inbox. */
export const SETTLE_TAGS: Record<NonNullable<Thread["settleReason"]>, string> = {
  user: "settled",
  "pr-merged": "merged",
  "merged-back": "merged",
  inactive: "inactive",
};

/** Thread ids of the rail's rows in visible order: what a shift-click range spans. */
export function visibleOrder(from: HTMLElement): string[] {
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

export interface RailThreadRowProps {
  thread: Thread;
  /** the row's nested children, prebuilt by the rail (stable across renders, so the memo holds) */
  childNodes?: readonly RailNode[] | undefined;
  /** without `childNodes`: the threads to find this row's children among */
  siblings?: readonly Thread[];
  /** the rail's minute clock: re-renders the relative time */
  now?: number | undefined;
  /** scope is All and there is more than one project: a project initial in the meta column */
  showProject?: boolean;
  /** a server search hit: its snippet is the second line */
  hit?: SearchHit;
  /** rendered inside its parent's children list (the parent row sits right above) */
  nested?: boolean;
}

/**
 * A rail thread row: status glyph (a settle box on hover), title, meta column
 * (harness, project, time), an optional tag line, and hover merge / `…` actions.
 * Children (forks, delegates) nest below it. Memoized: the inner function has its own
 * name so the nested `<RailThreadRow>` below resolves to the memo, not to itself.
 */
export const RailThreadRow = memo(function RailThreadRowView({ thread, childNodes, siblings, now, showProject = false, hit, nested = false }: RailThreadRowProps) {
  const active = useUi((s) => s.view === "thread" && s.selectedThreadId === thread.id);
  const selectThread = useUi((s) => s.selectThread);
  const picked = useRailSelection((s) => s.ids.includes(thread.id));
  const count = useModel((s) => activityCount(s.model, thread.id));
  const projectTitle = useModel((s) => (showProject ? s.model.projects[thread.projectId]?.title : undefined));
  const selectedId = useUi((s) => (s.view === "thread" ? s.selectedThreadId : null));
  const unread = useLastSeen((s) => isUnread(thread, count, s, selectedId));
  // a string from the store, not an object: a fresh object per render would loop the selector
  const liveKey = useModel((s) => liveLabelKey(liveLabelFor(s.model, s.model.threads[thread.id] ?? thread)));
  const live = parseLiveLabelKey(liveKey);
  const snoozeAsked = useRailMenuRequest((s) => s.snoozeFor === thread.id);
  const settled = thread.settledAt !== undefined;
  const [menu, setMenu] = useState<{ at: MenuPosition; items: MenuItem[]; label: string } | undefined>(undefined);
  const [renaming, setRenaming] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const low = useServerSettings((s) => s.settings.decisions.grayZone.low);
  const j = thread.judge;
  const judge = thread.delegatedBy !== undefined && thread.status !== "running" && j?.label !== undefined && j.confidence >= low ? { label: j.label, source: j.source, confidence: j.confidence } : undefined;
  const fromSiblings = useMemo(() => (childNodes !== undefined || siblings === undefined ? NO_NODES : childNodesIn(siblings, thread.id)), [childNodes, siblings, thread.id]);
  const children = childNodes ?? fromSiblings;
  const archived = thread.archivedAt !== undefined;
  const background = useBackgroundAgentCount(thread.id);
  const state = threadStateKey(thread, Date.now(), background);
  const recede = recedes({ state, unread, active, picked, live });
  const merged = thread.merge !== undefined || isThreadMerged(thread);
  const mergeable = !archived && canMergeBack(thread);
  const snoozedUntil = thread.snoozedUntil !== undefined && thread.snoozedUntil > Date.now() ? thread.snoozedUntil : undefined;
  const harness = useThreadHarnessLabel(thread);
  const tip = [
    `${PROVIDER_MONOGRAMS[thread.provider]} · ${harness}`,
    thread.worktreePath === undefined ? undefined : `worktree ${thread.worktreePath}`,
  ]
    .filter(Boolean)
    .join(" · ");
  // a child listed away from its parent (the parent sits in another group): say whose it is
  const parentId = parentOf(thread);
  const parentTitle = useModel((s) => (nested || parentId === undefined ? undefined : s.model.threads[parentId]?.title));
  const hasTags =
    hit !== undefined || (settled && thread.settleReason !== undefined) || thread.pr !== undefined || merged ||
    judge !== undefined || thread.delegateRole !== undefined || snoozedUntil !== undefined || parentTitle !== undefined;

  const openMenu = (at: MenuPosition): void =>
    setMenu({ at, label: "Thread actions", items: threadMenu(useModel.getState().model, thread, () => setRenaming(true)) });

  // `s` on the focused row: the snooze choices, anchored under the row
  useEffect(() => {
    if (!snoozeAsked) return;
    requestRailSnooze(null);
    const rect = rowRef.current?.getBoundingClientRect();
    setMenu({ at: { x: rect?.left ?? 0, y: rect?.bottom ?? 0 }, label: "Snooze", items: snoozeItems(thread.id) });
  }, [snoozeAsked, thread.id]);

  return (
    <li>
      <div
        ref={rowRef}
        className={[
          styles.row,
          active ? styles.active : "",
          picked ? styles.picked : "",
          archived ? styles.archived : "",
          settled ? styles.settled : "",
          state === "needs" ? styles.needsRow : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-rail-thread={thread.id}
        data-recede={recede ? "" : undefined}
        draggable={!renaming}
        onDragStart={(e) => {
          // R11: dropped on the composer, it becomes an @thread context mention
          e.dataTransfer.setData(THREAD_DRAG_TYPE, thread.id);
          e.dataTransfer.effectAllowed = "copy";
        }}
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
            className={styles.main}
            title={tip}
            data-rail-main=""
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
            <span className={styles.line}>
              <span className={styles.glyph}>
                <ThreadGlyph thread={thread} />
              </span>
              {thread.role && !(thread.role === "delegate" && !nested) ? (
                <span className={styles.roleGlyph} title={thread.role} aria-label={thread.role} role="img">
                  {ROLE_GLYPH[thread.role]}
                </span>
              ) : null}
              {thread.team ? (
                <span className={styles.roleGlyph} title={`Team run: ${thread.team.name}`} aria-label="team" role="img">
                  ⛓
                </span>
              ) : null}
              <span className={styles.title}>{thread.title}</span>
              {thread.pinned && !archived ? <Icon name="pin" size={12} label="pinned" className={styles.pinMark ?? ""} /> : null}
              {unread ? <span className={styles.unread} aria-label="unread" role="img" title="New activity" /> : null}
              <span className={styles.meta}>
                <span className={styles.monogram} title={harness}>
                  {PROVIDER_MONOGRAMS[thread.provider]}
                </span>
                {projectTitle !== undefined ? (
                  <span className={styles.projectPill} title={projectTitle}>
                    {firstGrapheme(projectTitle).toUpperCase()}
                  </span>
                ) : null}
                <span className={styles.time}>{relativeTime(thread.updatedAt, now)}</span>
              </span>
            </span>
            {live !== undefined && hit === undefined ? (
              <RailLiveLine live={live} title={live.kind === "background" ? backgroundAgentsTip(background) : undefined} />
            ) : hasTags ? (
              <span className={styles.tags}>
                {hit !== undefined ? (
                  <span className={styles.snippet} title={hit.snippet}>
                    {hit.field === "message" ? <Icon name="search" size={12} label="message match" /> : null}
                    <span className={styles.snippetText}>{hit.snippet}</span>
                  </span>
                ) : null}
                {settled && thread.settleReason ? (
                  <span className={styles.settleTag} title="Settled: out of the inbox, worktree kept">
                    {SETTLE_TAGS[thread.settleReason]}
                  </span>
                ) : null}
                {thread.pr !== undefined ? <span className={styles.tag}>PR #{thread.pr.number}</span> : null}
                {merged ? <MergeGlyph thread={thread} /> : null}
                {parentTitle !== undefined ? (
                  <span className={styles.tag} title={`Delegated by ${parentTitle}`}>
                    <Icon name="arrowRight" size={12} /> {parentTitle}
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
                {snoozedUntil !== undefined ? (
                  <span className={styles.tag}>
                    <Icon name="snooze" size={12} /> {relativeUntil(snoozedUntil)}
                  </span>
                ) : null}
              </span>
            ) : null}
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
            {settled ? <Icon name="check" size={12} /> : null}
          </button>
        )}
        <span className={styles.actions}>
          {mergeable ? (
            <button
              type="button"
              className={styles.action}
              aria-label={`Merge back ${thread.title}`}
              title="Merge back into the base branch (m)"
              onClick={() => void mergeBackThread(thread.id)}
            >
              <Icon name="merge" size={14} />
            </button>
          ) : null}
          <button
            type="button"
            className={styles.action}
            aria-label={`Actions for ${thread.title}`}
            title="More actions"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              openMenu({ x: rect.left, y: rect.bottom });
            }}
          >
            <Icon name="more" size={14} />
          </button>
        </span>
      </div>
      {renaming || menu ? null : <RailHoverCard thread={thread} anchor={rowRef} />}
      {menu ? (
        <ContextMenu position={menu.at} items={menu.items} onClose={() => setMenu(undefined)} label={menu.label} />
      ) : null}
      {children.length > 0 ? (
        <ul className={styles.children}>
          {children.map((c) => (
            <RailThreadRow key={c.thread.id} thread={c.thread} childNodes={c.children} showProject={showProject ?? false} now={now} nested />
          ))}
        </ul>
      ) : null}
    </li>
  );
});
