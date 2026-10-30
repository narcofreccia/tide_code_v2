import { useEffect, useState } from "react";
import { effectiveTheme, toggleTheme, THEME_EVENT } from "../../state/settings.ts";
import { Icon } from "../ui/Icon.tsx";
import styles from "./ThemeToggle.module.css";

/**
 * Quick light/dark flip in the chrome. Settings › Appearance keeps the full
 * System/Dark/Light choice; this only ever lands on an explicit one.
 */
export function ThemeToggle() {
  const [current, setCurrent] = useState(() => effectiveTheme());

  useEffect(() => {
    const onChange = (): void => setCurrent(effectiveTheme());
    const query = window.matchMedia?.("(prefers-color-scheme: light)");
    query?.addEventListener("change", onChange);
    window.addEventListener(THEME_EVENT, onChange);
    return () => {
      query?.removeEventListener("change", onChange);
      window.removeEventListener(THEME_EVENT, onChange);
    };
  }, []);

  const now = current === "dark" ? "Dark" : "Light";
  const next = current === "dark" ? "Light" : "Dark";
  const hint = `Theme: ${now} — click for ${next} (⌘⇧L)`;
  return (
    <button
      type="button"
      className={styles.toggle}
      title={hint}
      aria-label="Toggle light/dark"
      aria-pressed={current === "light"}
      onClick={() => setCurrent(toggleTheme())}
    >
      <Icon name={current === "dark" ? "moon" : "sun"} size={16} />
    </button>
  );
}
