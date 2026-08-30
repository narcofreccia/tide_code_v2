import { useUi } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import styles from "./SettingsView.module.css";

const SECTIONS = ["Providers", "Git", "Appearance", "Keyboard", "Remote"];

export function SettingsView() {
  const showMission = useUi((s) => s.showMission);
  return (
    <section className={styles.view} aria-label="Settings">
      <div className={styles.header}>
        <h2 className={styles.heading}>Settings</h2>
        <Button variant="quiet" onClick={showMission}>
          Close
        </Button>
      </div>
      <ul className={styles.list}>
        {SECTIONS.map((section) => (
          <li key={section} className={styles.row}>
            <span>{section}</span>
            <span className={styles.soon}>coming soon</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
