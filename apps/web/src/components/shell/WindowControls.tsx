import { desktopPlatform, sendWindowAction } from "../../lib/windowChrome.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import styles from "./WindowControls.module.css";

/**
 * Minimise · maximise/restore · close at the right edge of the top row, Windows only: the
 * shell makes that window frameless so the app's top bar is its only title bar. Not a drag
 * region (buttons never are, and the group carries no `data-tauri-drag-region`). One
 * maximise glyph serves both states: the page has no channel that tells it which one it is in.
 */
export function WindowControls() {
  if (desktopPlatform() !== "win") return null;
  return (
    <div className={styles.controls} role="group" aria-label="Window">
      <Button variant="quiet" className={styles.control} aria-label="Minimize" title="Minimize" onClick={() => sendWindowAction("minimize")}>
        <Icon name="windowMinimize" />
      </Button>
      <Button
        variant="quiet"
        className={styles.control}
        aria-label="Maximize or restore"
        title="Maximize / Restore"
        onClick={() => sendWindowAction("toggle-maximize")}
      >
        <Icon name="windowMaximize" />
      </Button>
      <Button
        variant="quiet"
        className={`${styles.control} ${styles.close}`}
        aria-label="Close"
        title="Close"
        onClick={() => sendWindowAction("close")}
      >
        <Icon name="close" />
      </Button>
    </div>
  );
}

/**
 * A top strip for screens that replace the whole app (the render-error screen): on Windows the
 * window would otherwise have nothing to drag it by and no close button.
 */
export function WindowStrip() {
  if (desktopPlatform() !== "win") return null;
  return (
    <div className={styles.strip} data-tauri-drag-region>
      <WindowControls />
    </div>
  );
}
