import { useEffect, useMemo, useRef, useState } from "react";
import { SETTINGS_SECTIONS, useUi, type SettingsSection } from "../../state/ui.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { GeneralSection, META as general } from "./GeneralSection.tsx";
import { ProjectsSection, META as projects } from "./ProjectsSection.tsx";
import { InboxSection, META as inbox } from "./InboxSection.tsx";
import { NotificationsSection, META as notifications } from "./NotificationsSection.tsx";
import { ProvidersSection, META as providers } from "./ProvidersSection.tsx";
import { GitSection, META as git } from "./GitSection.tsx";
import { DecisionsSection, META as decisions } from "./DecisionsSection.tsx";
import { AutomationsSection, META as automations } from "./AutomationsSection.tsx";
import { TeamsSection, META as teams } from "./TeamsSection.tsx";
import { AppearanceSection, META as appearance } from "./AppearanceSection.tsx";
import { KeyboardSection, META as keyboard } from "./KeyboardSection.tsx";
import { EnvironmentsSection, META as environments } from "./EnvironmentsSection.tsx";
import { AboutSection, META as about } from "./AboutSection.tsx";
import { GlassBoxSection, META as glassBox } from "./GlassBoxSection.tsx";
import { searchSettings, type SectionMeta } from "./search.ts";
import { rowId } from "./ui/saved.ts";
import styles from "./SettingsView.module.css";

/** The static search index: each section's header and row labels. */
export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  general,
  projects,
  inbox,
  notifications,
  providers,
  git,
  decisions,
  automations,
  teams,
  appearance,
  keyboard,
  environments,
  glassBox,
  about,
};

const FLASH_MS = 1200;

function Body({ section }: { section: SettingsSection }) {
  switch (section) {
    case "general":
      return <GeneralSection />;
    case "projects":
      return <ProjectsSection />;
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

/** Scrolls to the row a search result named, once its section has rendered, and tints it briefly. */
function useScrollTarget(target: string | null, section: SettingsSection, done: () => void): void {
  useEffect(() => {
    if (target === null) return undefined;
    const el = document.getElementById(target);
    done();
    if (!el) return undefined;
    el.scrollIntoView?.({ block: "center" });
    el.setAttribute("data-flash", "");
    const timer = setTimeout(() => el.removeAttribute("data-flash"), FLASH_MS);
    return () => clearTimeout(timer);
  }, [target, section, done]);
}

/** `⌘,` opens Settings; `Esc` goes back to whatever view it was opened from (or clears the search first). */
export function SettingsView() {
  const section = useUi((s) => s.settingsSection);
  const setSection = useUi((s) => s.setSettingsSection);
  const closeSettings = useUi((s) => s.closeSettings);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const match = useMemo(() => searchSettings(query, SETTINGS_SECTIONS, SECTION_META), [query]);
  const clearTarget = useMemo(() => () => setTarget(null), []);
  useScrollTarget(target, section, clearTarget);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey) return;
      event.preventDefault();
      closeSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [closeSettings]);

  const open = (next: SettingsSection): void => {
    setSection(next);
    content.current?.scrollTo?.({ top: 0 });
  };

  return (
    <section className={styles.view} aria-label="Settings">
      <aside className={styles.side}>
        <h2 className={styles.heading}>Settings</h2>
        <label className={styles.search}>
          <span className={styles.searchIcon}>
            <Icon name="search" size={14} />
          </span>
          <input
            className={styles.searchInput}
            type="search"
            aria-label="Search settings"
            placeholder="Search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape" || query === "") return;
              e.preventDefault();
              e.stopPropagation();
              setQuery("");
            }}
          />
        </label>
        <nav className={styles.nav} aria-label="Settings sections">
          <ul className={styles.list}>
            {match.sections.map((item) => (
              <li key={item}>
                <button
                  type="button"
                  className={`${styles.navItem} ${item === section ? styles.active : ""}`}
                  aria-current={item === section ? "page" : undefined}
                  onClick={() => open(item)}
                >
                  {SECTION_META[item].title}
                </button>
              </li>
            ))}
          </ul>
          {query.trim() !== "" && match.sections.length === 0 ? <p className={styles.empty}>No settings match.</p> : null}
        </nav>
        {match.rows.length > 0 ? (
          <ul className={styles.results} aria-label="Matching settings">
            {match.rows.map((row) => (
              <li key={`${row.section}:${row.label}`}>
                <button
                  type="button"
                  className={styles.result}
                  onClick={() => {
                    setSection(row.section);
                    setTarget(rowId(row.label));
                  }}
                >
                  <span className={styles.resultSection}>{SECTION_META[row.section].title} ›</span> {row.label}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className={styles.foot}>
          <Button variant="quiet" onClick={closeSettings}>
            Close
          </Button>
          <Kbd>Esc</Kbd>
        </div>
      </aside>
      <div className={styles.content} ref={content}>
        <Body section={section} />
      </div>
    </section>
  );
}
