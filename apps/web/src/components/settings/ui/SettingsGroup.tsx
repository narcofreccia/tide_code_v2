import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../ui/Icon.tsx";
import { SavedContext } from "./saved.ts";
import styles from "./settings.module.css";

const SAVED_MS = 1800;

/**
 * A card of rows under a title. Controls inside it that patch the server flash "Saved" in the
 * header (see `useTrackSave`). `collapsible` turns the title into a disclosure, closed by default.
 */
export function SettingsGroup({
  title,
  help,
  actions,
  children,
  collapsible = false,
  defaultOpen = false,
  label,
}: {
  title: React.ReactNode;
  help?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  collapsible?: boolean;
  defaultOpen?: boolean;
  /** accessible name of the group when `title` is not plain text */
  label?: string;
}) {
  const [saved, setSaved] = useState(false);
  const [open, setOpen] = useState(!collapsible || defaultOpen);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const bodyId = useId();
  const titleId = useId();

  const flash = useCallback(() => {
    setSaved(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSaved(false), SAVED_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  return (
    <section
      className={styles.group}
      {...(label === undefined ? { "aria-labelledby": titleId } : { "aria-label": label })}
    >
      <div className={styles.groupHead}>
        <div className={styles.groupText}>
          <div className={styles.groupTitleRow}>
            <h3 className={styles.groupTitle} id={titleId}>
              {collapsible ? (
                <button
                  type="button"
                  className={styles.disclosure}
                  aria-expanded={open}
                  aria-controls={bodyId}
                  onClick={() => setOpen((v) => !v)}
                >
                  <Icon name="chevronRight" size={14} className={`${styles.chevron} ${open ? styles.chevronOpen : ""}`} />
                  {title}
                </button>
              ) : (
                title
              )}
            </h3>
            <span className={styles.saved} aria-live="polite">
              {saved ? "Saved" : ""}
            </span>
          </div>
          {help === undefined ? null : <p className={styles.groupHelp}>{help}</p>}
        </div>
        {actions === undefined ? null : <div className={styles.groupActions}>{actions}</div>}
      </div>
      {open ? (
        <SavedContext.Provider value={flash}>
          <div className={styles.groupBody} id={bodyId}>
            {children}
          </div>
        </SavedContext.Provider>
      ) : null}
    </section>
  );
}

/** Muted explanatory text inside a group, between or after rows. */
export function SettingNote({ children, role }: { children: React.ReactNode; role?: "status" | "alert" }) {
  return (
    <p className={styles.note} role={role}>
      {children}
    </p>
  );
}

/** Free content (cards, forms, tables) laid out inside a group with row padding. */
export function SettingBlock({ children, flush = false }: { children: React.ReactNode; flush?: boolean }) {
  return flush ? <div>{children}</div> : <div className={styles.block}>{children}</div>;
}
