import { useEffect, useState } from "react";
import { effectiveTheme, toggleTheme, THEME_EVENT } from "../../state/settings.ts";
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

  const hint = `Toggle light/dark (⌘⇧L) — now ${current}`;
  return (
    <button
      type="button"
      className={styles.toggle}
      title={hint}
      aria-label={hint}
      aria-pressed={current === "light"}
      onClick={() => setCurrent(toggleTheme())}
    >
      {current === "dark" ? "☾" : "☀"}
    </button>
  );
}
