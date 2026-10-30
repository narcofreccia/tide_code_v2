import { useUi } from "../../state/ui.ts";
import { useViewHeading } from "../../state/hooks.ts";
import { useMobileNav } from "./mobileNav.ts";
import styles from "./PhoneTopBar.module.css";

/** Phone top bar: a back button and the screen title; threads add Code and ⚙ actions. */
export function PhoneTopBar() {
  const view = useUi((s) => s.view);
  const heading = useViewHeading();
  const inboxOpen = useMobileNav((s) => s.inboxOpen);
  const codeOpen = useMobileNav((s) => s.codeOpen);
  const nested = heading.kind === "thread" || view === "experts" || view === "threads";
  const onThread = heading.kind === "thread";

  const back = (): void => {
    const nav = useMobileNav.getState();
    nav.setCodeOpen(false);
    nav.setSheetOpen(false);
    if (codeOpen) return;
    nav.setInboxOpen(true);
    const ui = useUi.getState();
    ui.selectThread(null);
    ui.showMission();
  };

  const title = onThread
    ? heading.thread.title
    : view === "mission"
      ? inboxOpen
        ? "Inbox"
        : "Mission Control"
      : heading.kind === "label"
        ? heading.label
        : "";

  return (
    <header className={styles.bar} data-phone-topbar>
      {nested ? (
        <button type="button" className={styles.back} aria-label={codeOpen ? "Back to thread" : "Back to inbox"} onClick={back}>
          ‹
        </button>
      ) : null}
      <span className={styles.title}>{title}</span>
      {onThread ? (
        <>
          <button
            type="button"
            className={styles.action}
            aria-label="Thread settings"
            onClick={() => useMobileNav.getState().setSheetOpen(true)}
          >
            ⚙
          </button>
          <button
            type="button"
            className={styles.action}
            aria-pressed={codeOpen}
            onClick={() => useMobileNav.getState().setCodeOpen(!codeOpen)}
          >
            {codeOpen ? "Chat" : "Code"}
          </button>
        </>
      ) : null}
    </header>
  );
}
