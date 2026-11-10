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
import { MachineSlotContext, SettingsGateContext, type SettingsGate } from "./ui/SettingsPage.tsx";
import { EnvSelect } from "../fleet/EnvSelect.tsx";
import { retryServerSettings, selectSettingsEnv, useSelectedSettings, useServerSettings } from "../../state/serverSettings.ts";
import { useDeviceLimit } from "../../state/deviceAccess.ts";
import { useEscape } from "../../lib/useEscape.ts";
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

/** Sections whose values live on the server: per-environment ones plus Keyboard (the primary's keybindings). */
function serverBacked(section: SettingsSection): boolean {
  return SECTION_META[section].perEnvironment === true || section === "keyboard";
}

/** The gate the open section shows: the selected environment's `settings.get` state. */
function useGate(section: SettingsSection): SettingsGate {
  const state = useSelectedSettings((entry) => (entry.loaded ? "ready" : (entry.error ?? "loading")));
  // keyboard writes the primary's keybindings; the per-environment sections the selected machine's
  const selectedId = useServerSettings((s) => (section === "keyboard" ? undefined : s.selectedId));
  const limit = useDeviceLimit(selectedId);
  return useMemo(() => {
    if (!serverBacked(section)) return { status: "ready" };
    if (limit !== undefined) return { status: "limited", message: limit };
    if (state === "ready") return { status: "ready" };
    if (state === "loading") return { status: "loading" };
    return { status: "error", message: state, retry: () => void retryServerSettings() };
  }, [section, state, limit]);
}

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

/**
 * `⌘,` opens Settings; `Esc` goes back to whatever view it was opened from. From a field it
 * first clears the search, or leaves the field (an uncommitted edit is dropped); the next Esc closes.
 */
export function SettingsView() {
  const section = useUi((s) => s.settingsSection);
  const setSection = useUi((s) => s.setSettingsSection);
  const closeSettings = useUi((s) => s.closeSettings);
  const [query, setQuery] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const content = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLElement>(null);
  const gate = useGate(section);
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const perEnvironment = SECTION_META[section].perEnvironment === true;
  // the store's selection is live only while a per-environment section shows, so edits made
  // elsewhere (appearance, keyboard, other views) never land on the chosen machine
  useEffect(() => {
    selectSettingsEnv(perEnvironment ? chosen : undefined);
    return () => selectSettingsEnv(undefined);
  }, [perEnvironment, chosen]);
  const match = useMemo(() => searchSettings(query, SETTINGS_SECTIONS, SECTION_META), [query]);
  const clearTarget = useMemo(() => () => setTarget(null), []);
  useScrollTarget(target, section, clearTarget);

  useEscape(closeSettings, { root });

  const open = (next: SettingsSection): void => {
    setSection(next);
    content.current?.scrollTo?.({ top: 0 });
  };

  return (
    <section ref={root} className={styles.view} aria-label="Settings">
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
        <MachineSlotContext.Provider
          value={perEnvironment ? <EnvSelect label="Settings of" value={chosen} onSelect={setChosen} /> : null}
        >
          <SettingsGateContext.Provider value={gate}>
            <Body section={section} />
          </SettingsGateContext.Provider>
        </MachineSlotContext.Provider>
      </div>
    </section>
  );
}
