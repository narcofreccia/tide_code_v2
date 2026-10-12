import { useEffect } from "react";
import { SETTINGS_SECTIONS, useUi, type SettingsSection } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { ProvidersSection } from "./ProvidersSection.tsx";
import { GitSection } from "./GitSection.tsx";
import { DecisionsSection } from "./DecisionsSection.tsx";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { KeyboardSection } from "./KeyboardSection.tsx";
import { RemoteSection } from "./RemoteSection.tsx";
import { AboutSection } from "./AboutSection.tsx";
import styles from "./SettingsView.module.css";

const LABELS: Record<SettingsSection, string> = {
  providers: "Providers",
  git: "Git",
  decisions: "Decisions",
  appearance: "Appearance",
  keyboard: "Keyboard",
  remote: "Remote",
  about: "About",
};

function Body({ section }: { section: SettingsSection }) {
  switch (section) {
    case "providers":
      return <ProvidersSection />;
    case "git":
      return <GitSection />;
    case "decisions":
      return <DecisionsSection />;
    case "appearance":
      return <AppearanceSection />;
    case "keyboard":
      return <KeyboardSection />;
    case "remote":
      return <RemoteSection />;
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
