import { selectInbox } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Icon, type IconName } from "../ui/Icon.tsx";
import { useMobileNav } from "./mobileNav.ts";
import styles from "./TabBar.module.css";

type Tab = "inbox" | "mission" | "prs" | "settings";

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "mission", label: "Mission", icon: "mission" },
  { id: "prs", label: "PRs", icon: "pullRequest" },
  { id: "settings", label: "Settings", icon: "settings" },
];

/** Phone bottom navigation: Inbox · Mission · PRs · Settings. The active tab follows the route. */
export function TabBar() {
  const view = useUi((s) => s.view);
  const inboxOpen = useMobileNav((s) => s.inboxOpen);
  const needsYou = useModel((s) => selectInbox(s.model).length);
  const active: Tab | undefined =
    view === "settings" ? "settings" : view === "prs" ? "prs" : view === "mission" ? (inboxOpen ? "inbox" : "mission") : undefined;

  const go = (tab: Tab): void => {
    const ui = useUi.getState();
    useMobileNav.getState().setCodeOpen(false);
    if (tab === "settings") {
      ui.showSettings();
      return;
    }
    if (tab === "prs") {
      ui.showPrs(null);
      return;
    }
    useMobileNav.getState().setInboxOpen(tab === "inbox");
    ui.selectThread(null);
    ui.showMission();
  };

  return (
    <nav className={styles.bar} aria-label="Primary">
      {TABS.map(({ id, label, icon }) => {
        const badge = id === "inbox" && needsYou > 0 ? needsYou : undefined;
        return (
          <button
            key={id}
            type="button"
            className={`${styles.tab} ${active === id ? styles.active : ""}`}
            aria-current={active === id ? "page" : undefined}
            onClick={() => go(id)}
          >
            <span className={styles.iconWrap}>
              <Icon name={icon} size={22} />
              {badge === undefined ? null : (
                <span className={styles.badge} title={`${badge} need you`}>
                  {badge}
                </span>
              )}
            </span>
            <span className={styles.label}>{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
