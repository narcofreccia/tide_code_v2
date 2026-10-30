import { selectInbox, selectOpenPrCount } from "@tide/client";
import type { EnvConnection } from "../../state/environments.ts";
import { useEnvironments } from "../../state/environments.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { usePrs } from "../prs/prData.ts";
import { EnvDot } from "../fleet/FleetBits.tsx";
import { useMultiEnv } from "../fleet/envView.ts";
import { Icon, type IconName } from "../ui/Icon.tsx";
import styles from "./Strip.module.css";

/** Open PRs: the PR tab's list once it has loaded, else the thread-linked ones the read model knows. */
export function useOpenPrCount(): number {
  const listed = usePrs((s) => (s.fetchedAt === undefined ? undefined : s.items.filter((i) => i.pr.state === "open").length));
  const known = useModel((s) => selectOpenPrCount(s.model));
  return listed ?? known;
}

/** Threads waiting on the user (a thread with three cards counts once). */
export function useNeedsYouCount(): number {
  return useModel((s) => new Set(selectInbox(s.model).map((i) => i.thread.id)).size);
}

/** One connection for the whole fleet: connected only when every environment is. */
function useFleetConnection(): { connection: EnvConnection; label: string } {
  const total = useEnvironments((s) => s.environments.length);
  const live = useEnvironments((s) => s.environments.filter((e) => s.statuses[e.id]?.connection === "connected").length);
  const connecting = useEnvironments((s) => s.environments.some((e) => s.statuses[e.id]?.connection === "connecting"));
  const connection: EnvConnection = live === total ? "connected" : connecting ? "connecting" : "offline";
  return { connection, label: `Environments: ${live} of ${total} connected` };
}

function StripButton({
  icon,
  name,
  shortcut,
  label,
  active,
  pressed,
  badge,
  tone = "needs",
  onClick,
}: {
  icon: IconName;
  name: string;
  shortcut?: string;
  /** accessible name when it says more than `name` (a count) */
  label?: string;
  active?: boolean;
  pressed?: boolean;
  badge?: number;
  /** needs-you counts are amber; plain counts are quiet */
  tone?: "needs" | "count";
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${styles.button} ${active ? styles.active : ""}`}
      aria-label={label ?? name}
      title={shortcut ? `${name} (${shortcut})` : name}
      aria-current={active ? "page" : undefined}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon name={icon} size={18} />
      {badge !== undefined && badge > 0 ? (
        <span className={`${styles.badge} ${tone === "count" ? styles.quiet : ""}`} aria-hidden="true">
          {badge > 99 ? "99+" : badge}
        </span>
      ) : null}
    </button>
  );
}

/** The project Experts opens on: the rail's filter, else the open thread's, else the first. */
function expertsProject(): string | undefined {
  const ui = useUi.getState();
  if (ui.selectedProjectId !== null) return ui.selectedProjectId;
  const model = useModel.getState().model;
  const fromThread = ui.selectedThreadId ? model.threads[ui.selectedThreadId]?.projectId : undefined;
  return fromThread ?? Object.values(model.projects).find((p) => p.archivedAt === undefined)?.id;
}

/**
 * The 44px icon strip, always visible on desktop: pages on top (Mission Control,
 * Inbox = the rail toggle, Pull requests, Usage, Experts), environments and
 * Settings at the bottom.
 */
export function Strip() {
  const view = useUi((s) => s.view);
  const railOpen = useUi((s) => !s.railCollapsed);
  const needs = useNeedsYouCount();
  const prs = useOpenPrCount();
  const multiEnv = useMultiEnv();
  const fleet = useFleetConnection();
  const ui = useUi.getState;

  return (
    <nav className={styles.strip} aria-label="Pages">
      <div className={styles.group}>
        <StripButton icon="mission" name="Mission Control" shortcut="⌘0" active={view === "mission"} onClick={() => ui().showMission()} />
        <StripButton
          icon="inbox"
          name="Inbox"
          shortcut="⌘B"
          label={needs > 0 ? `Inbox · ${needs} need you` : "Inbox"}
          pressed={railOpen}
          badge={needs}
          onClick={() => ui().toggleRail()}
        />
        <StripButton
          icon="pullRequest"
          name="Pull requests"
          label={prs > 0 ? `Pull requests · ${prs} open` : "Pull requests"}
          active={view === "prs"}
          badge={prs}
          tone="count"
          onClick={() => ui().showPrs(null)}
        />
        <StripButton icon="usage" name="Usage" active={view === "usage"} onClick={() => ui().showUsage()} />
        <StripButton
          icon="experts"
          name="Experts"
          shortcut="⌘⇧X"
          active={view === "experts"}
          onClick={() => {
            const projectId = expertsProject();
            if (projectId !== undefined) ui().setNewExpertsProject(projectId);
          }}
        />
      </div>
      <div className={styles.group}>
        {multiEnv ? (
          <button
            type="button"
            className={styles.button}
            aria-label={fleet.label}
            title={fleet.label}
            onClick={() => ui().openSettings("environments")}
          >
            <Icon name="environment" size={18} />
            <span className={styles.envDot}>
              <EnvDot connection={fleet.connection} />
            </span>
          </button>
        ) : null}
        <StripButton icon="settings" name="Settings" shortcut="⌘," active={view === "settings"} onClick={() => ui().toggleSettings()} />
      </div>
    </nav>
  );
}
