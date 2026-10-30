import { useEffect } from "react";
import { SETTINGS_SECTIONS, useUi, type SettingsSection } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { GeneralSection } from "./GeneralSection.tsx";
import { InboxSection } from "./InboxSection.tsx";
import { NotificationsSection } from "./NotificationsSection.tsx";
import { ProvidersSection } from "./ProvidersSection.tsx";
import { GitSection } from "./GitSection.tsx";
import { DecisionsSection } from "./DecisionsSection.tsx";
import { AutomationsSection } from "./AutomationsSection.tsx";
import { TeamsSection } from "./TeamsSection.tsx";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { KeyboardSection } from "./KeyboardSection.tsx";
import { EnvironmentsSection } from "./EnvironmentsSection.tsx";
import { AboutSection } from "./AboutSection.tsx";
import { GlassBoxSection } from "./GlassBoxSection.tsx";
import styles from "./SettingsView.module.css";

const LABELS: Record<SettingsSection, string> = {
  general: "General",
  inbox: "Inbox",
  notifications: "Notifications",
  providers: "Providers",
  git: "Git",
  decisions: "Decisions",
  automations: "Automations",
  teams: "Teams",
  appearance: "Appearance",
  keyboard: "Keyboard",
  environments: "Environments",
  glassBox: "Glass box",
  about: "About",
};

function Body({ section }: { section: SettingsSection }) {
  switch (section) {
    case "general":
      return <GeneralSection />;
    case "inbox":
      return <InboxSection />;
    case "notifications":
      return <NotificationsSection />;
    case "providers":
      return <ProvidersSection />;
    case "git":
      return <GitSection />;
    case "decisions":
      return <DecisionsSection />;
    case "automations":
      return <AutomationsSection />;
    case "teams":
      return <TeamsSection />;
    case "appearance":
      return <AppearanceSection />;
    case "keyboard":
      return <KeyboardSection />;
    case "environments":
      return <EnvironmentsSection />;
    case "glassBox":
      return <GlassBoxSection />;
    default:
      return <AboutSection />;
  }
}

/** `⌘,` opens Settings; `Esc` goes back to whatever view it was opened from. */
export function SettingsView() {
  const section = useUi((s) => s.settingsSection);
  const setSection = useUi((s) => s.setSettingsSection);
  const closeSettings = useUi((s) => s.closeSettings);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings]);

  return (
    <section className={styles.view} aria-label="Settings">
      <nav className={styles.nav} aria-label="Settings sections">
        <h2 className={styles.heading}>Settings</h2>
        <ul className={styles.list}>
          {SETTINGS_SECTIONS.map((item) => (
            <li key={item}>
              <button
                type="button"
                className={`${styles.navItem} ${item === section ? styles.active : ""}`}
                aria-current={item === section ? "page" : undefined}
                onClick={() => setSection(item)}
              >
                {LABELS[item]}
              </button>
            </li>
          ))}
        </ul>
        <div className={styles.navFoot}>
          <Button variant="quiet" onClick={closeSettings}>
            Close
          </Button>
          <Kbd>Esc</Kbd>
        </div>
      </nav>
      <div className={styles.content}>
        <Body section={section} />
      </div>
    </section>
  );
}
