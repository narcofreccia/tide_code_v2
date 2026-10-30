import { selectInbox } from "@tide/client";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { useMobileNav } from "./mobileNav.ts";
import styles from "./TabBar.module.css";

/** Phone bottom navigation: Inbox · Mission · Settings. The active tab follows the route. */
export function TabBar() {
  const view = useUi((s) => s.view);
  const inboxOpen = useMobileNav((s) => s.inboxOpen);
  const count = useModel((s) => selectInbox(s.model).length);
  const active = view === "settings" ? "settings" : view === "mission" ? (inboxOpen ? "inbox" : "mission") : undefined;

  const go = (tab: "inbox" | "mission" | "settings"): void => {
    const ui = useUi.getState();
    useMobileNav.getState().setCodeOpen(false);
    if (tab === "settings") {
      ui.showSettings();
      return;
    }
    useMobileNav.getState().setInboxOpen(tab === "inbox");
    ui.selectThread(null);
    ui.showMission();
  };

  const tab = (id: "inbox" | "mission" | "settings", label: string, glyph: string, badge?: number) => (
    <button
      type="button"
      className={`${styles.tab} ${active === id ? styles.active : ""}`}
      aria-current={active === id ? "page" : undefined}
      onClick={() => go(id)}
    >
      <span className={styles.glyph} aria-hidden="true">{glyph}</span>
      <span>{label}</span>
      {badge ? <span className={styles.badge}>{badge}</span> : null}
    </button>
  );

  return (
    <nav className={styles.bar} aria-label="Primary">
      {tab("inbox", "Inbox", "▤", count)}
      {tab("mission", "Mission", "◫")}
      {tab("settings", "Settings", "⚙")}
    </nav>
  );
}
