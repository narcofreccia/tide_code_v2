import type { ExpertsSession, Thread } from "@tide/contracts";
import { useModel } from "../../state/model.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { clearEmptyArchived } from "../../lib/threadActions.ts";
import { useTicker } from "../mission/useTicker.ts";
import { Icon } from "../ui/Icon.tsx";
import { ExpertsGroup } from "./ExpertsGroup.tsx";
import { RailThreadRow, parentOf } from "./RailThreadRow.tsx";
import { RAIL_GROUP_LABELS, buildRailGroups, claimedBy, type RailGroup } from "./railGroupModel.ts";
import { isGroupCollapsed, useGroupFolds } from "./railGroupState.ts";
import styles from "./RailGroups.module.css";

/** A group's rows: sessions first (their threads nested), then roots with their children below them. */
function GroupBody({
  group,
  claimed,
  live,
  showProject,
}: {
  group: RailGroup;
  claimed: Set<string>;
  live: Thread[];
  showProject: boolean;
}) {
  const loose = group.key === "archived" ? group.threads : group.threads.filter((t) => !claimed.has(t.id));
  const listed = new Set(loose.map((t) => t.id));
  const roots = loose.filter((t) => {
    const parent = parentOf(t);
    return parent === undefined || !listed.has(parent);
  });
  const label = RAIL_GROUP_LABELS[group.key];
  return (
    <>
      {group.sessions.length > 0 ? (
        <ExpertsGroup
          sessions={group.sessions}
          threads={live}
          heading={false}
          renderThread={(t) => <RailThreadRow key={t.id} thread={t} siblings={live} showProject={showProject} />}
        />
      ) : null}
      {roots.length > 0 ? (
        <ul className={styles.list} aria-label={`${label} threads`}>
          {roots.map((t) => (
            <RailThreadRow key={t.id} thread={t} siblings={loose} showProject={showProject} />
          ))}
        </ul>
      ) : null}
    </>
  );
}

/**
 * The rail's one flat list for the scope (All, or one project): Needs you · Inbox ·
 * Working · Snoozed · Settled · Archived. Empty groups are not drawn; each label
 * folds its group, and the fold is remembered.
 */
export function RailGroups({ projectIds, showProject }: { projectIds: readonly string[]; showProject: boolean }) {
  const model = useModel((s) => s.model);
  const now = useTicker(60_000);
  const workingSection = useServerSettings((s) => s.settings.inbox.workingSection);
  const { folds, toggle } = useGroupFolds();
  const groups = buildRailGroups(model, projectIds, now, { workingSection });
  const sessions: ExpertsSession[] = groups.flatMap((g) => g.sessions);
  const claimed = claimedBy(sessions);
  const live = groups.filter((g) => g.key !== "archived").flatMap((g) => g.threads);

  return (
    <div className={styles.groups}>
      {groups.map((group) => {
        const count = group.threads.length;
        if (count === 0 && group.sessions.length === 0) return null;
        const label = RAIL_GROUP_LABELS[group.key];
        const collapsed = isGroupCollapsed(folds, group.key);
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
            {collapsed ? null : <GroupBody group={group} claimed={claimed} live={live} showProject={showProject} />}
          </section>
        );
      })}
    </div>
  );
}
