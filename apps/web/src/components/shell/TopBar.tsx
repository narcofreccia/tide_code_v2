import { openPalette } from "../../lib/commands.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { useViewHeading } from "../../state/hooks.ts";
import { envOfThread, useEnvironments } from "../../state/environments.ts";
import { Button } from "../ui/Button.tsx";
import { ConnectionDot } from "../ui/ConnectionDot.tsx";
import { Icon } from "../ui/Icon.tsx";
import { useViewport } from "../../lib/useViewport.ts";
import { PhoneTopBar } from "../mobile/PhoneTopBar.tsx";
import { EnvTag } from "../fleet/FleetBits.tsx";
import { useMultiEnv } from "../fleet/envView.ts";
import { Logo } from "./Logo.tsx";
import { ThemeToggle } from "./ThemeToggle.tsx";
import styles from "./TopBar.module.css";

/**
 * Logo · `Project › Thread` breadcrumb or the page heading · (env chip) connection,
 * theme, palette. Projects are picked in the rail, not here.
 */
export function TopBar() {
  const showMission = useUi((s) => s.showMission);
  const selectThread = useUi((s) => s.selectThread);
  const heading = useViewHeading();
  const status = useModel((s) => s.status);
  const multiEnv = useMultiEnv();
  const primaryId = useEnvironments((s) => s.primaryId);
  const { phone } = useViewport();

  if (phone) return <PhoneTopBar />;
  const envId = heading.kind === "thread" ? envOfThread(heading.thread.id) : primaryId;

  return (
    // Tauri v2 drags from this attribute (not `-webkit-app-region`), and only when
    // the event target *is* the element carrying it — so children stay clickable.
    <header className={styles.bar} data-tauri-drag-region>
      <Button
        variant="quiet"
        className={styles.logo}
        title="Mission Control (⌘0)"
        aria-label="Tide — Mission Control"
        onClick={() => {
          selectThread(null);
          showMission();
        }}
      >
        <Logo size={18} />
      </Button>

      {heading.kind === "thread" ? (
        <nav className={styles.crumb} aria-label="Breadcrumb">
          <span className={styles.crumbProject}>{heading.projectTitle}</span>
          <span aria-hidden="true">›</span>
          <span className={styles.crumbThread}>{heading.thread.title}</span>
        </nav>
      ) : (
        <span className={styles.heading}>{heading.label}</span>
      )}

      <div className={styles.end}>
        {multiEnv ? <EnvTag envId={envId} /> : null}
        <ConnectionDot status={status} />
        <ThemeToggle />
        <button type="button" className={styles.icon} title="Command palette (⌘K)" aria-label="Command palette" onClick={openPalette}>
          <Icon name="search" size={16} />
        </button>
      </div>
    </header>
  );
}
