import { memo, useMemo, useRef } from "react";
import type { Thread } from "@tide/contracts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { clearEmptyArchived } from "../../lib/threadActions.ts";
import { useTicker } from "../mission/useTicker.ts";
import { Icon } from "../ui/Icon.tsx";
import { StateGlyph } from "../ui/StatusGlyph.tsx";
import { ExpertsGroup } from "./ExpertsGroup.tsx";
import { RailThreadRow } from "./RailThreadRow.tsx";
import { RAIL_GROUP_LABELS } from "./railGroupModel.ts";
import { isGroupCollapsed, useGroupFolds } from "./railGroupState.ts";
import { useRailFlip } from "./railMotion.ts";
import { useRailGroups, type RailGroupView } from "./useRailGroups.ts";
import styles from "./RailGroups.module.css";

/** A group's rows: sessions first (their threads nested), then roots with their children below them. */
const GroupBody = memo(function GroupBody({
  view,
  live,
  showProject,
  now,
}: {
  view: RailGroupView;
  live: Thread[];
  showProject: boolean;
  now: number;
}) {
  const { group, roots, sessionNodes } = view;
  const label = RAIL_GROUP_LABELS[group.key];
  return (
    <>
      {group.sessions.length > 0 ? (
        <ExpertsGroup
          sessions={group.sessions}
          threads={live}
          heading={false}
          renderThread={(t) => {
            const node = sessionNodes.get(t.id);
            return <RailThreadRow key={t.id} thread={node?.thread ?? t} childNodes={node?.children} showProject={showProject} now={now} />;
          }}
        />
      ) : null}
      {roots.length > 0 ? (
        <ul className={styles.list} aria-label={`${label} threads`}>
          {roots.map((n) => (
            <RailThreadRow key={n.thread.id} thread={n.thread} childNodes={n.children} showProject={showProject} now={now} />
          ))}
        </ul>
      ) : null}
    </>
  );
});

/**
 * The rail's one flat list for the scope (All, or one project): Needs you · Inbox ·
 * Working · Snoozed · Settled · Archived. Empty groups are not drawn; each label
 * folds its group, and the fold is remembered. It re-renders only when the groups'
 * inputs change (see `useRailGroups`), never on streaming text.
 */
export function RailGroups({ projectIds, showProject }: { projectIds: readonly string[]; showProject: boolean }) {
  const now = useTicker(60_000);
  const workingSection = useServerSettings((s) => s.settings.inbox.workingSection);
  const { folds, toggle } = useGroupFolds();
  const { groups: views, live } = useRailGroups(projectIds, now, workingSection);
  // the rail's order; rows slide (FLIP) only when it changes
  const signature = useMemo(
    () =>
      views
        .map(({ group: g }) => `${g.key}${isGroupCollapsed(folds, g.key) ? "-" : ""}:${g.threads.map((t) => t.id).join(",")}:${g.sessions.map((x) => x.id).join(",")}`)
        .join("|"),
    [views, folds],
  );
  const rootRef = useRef<HTMLDivElement>(null);
  useRailFlip(rootRef, signature);

  return (
    <div ref={rootRef} className={styles.groups}>
      {views.map((view) => {
        const { group } = view;
        const count = group.threads.length;
        if (count === 0 && group.sessions.length === 0) return null;
        const label = RAIL_GROUP_LABELS[group.key];
        const collapsed = isGroupCollapsed(folds, group.key);
        const holdsWork = group.key === "working" || (group.key === "inbox" && workingSection !== true);
        const running = holdsWork && group.threads.some((t) => t.status === "running");
        return (
          <section key={group.key} className={styles.group} aria-label={label} data-rail-group={group.key}>
            <div className={styles.head}>
              <button
                type="button"
                className={`${styles.toggle} ${group.key === "needs" ? styles.needs : ""}`}
                aria-expanded={!collapsed}
                onClick={() => toggle(group.key)}
              >
                <Icon name={collapsed ? "chevronRight" : "chevronDown"} size={12} />
                <span className={styles.label}>{label}</span>
                <span className={styles.count}>{count}</span>
                {running ? (
                  <span className={styles.runningDot} data-group-running="">
                    <StateGlyph state="running" />
                  </span>
                ) : null}
              </button>
              {group.key === "archived" ? (
                <button
                  type="button"
                  className={styles.clear}
                  title="Delete archived threads that have no turns"
                  onClick={() => clearEmptyArchived(group.threads)}
                >
                  Clear
                </button>
              ) : null}
            </div>
            {collapsed ? null : <GroupBody view={view} live={live} showProject={showProject} now={now} />}
          </section>
        );
      })}
    </div>
  );
}
