import { openSearchTab, setQuickOpen } from "../../state/workbench.ts";
import { createPty, setDrawerOpen } from "../../state/terminals.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import { Popover } from "../ui/Popover.tsx";
import styles from "./Workbench.module.css";

/** The tab strip's "+": the ways in to the editor and terminal, with their shortcuts. */
export function AddMenu({ threadId }: { threadId: string }) {
  return (
    <Popover label={<Icon name="plus" size={14} />} ariaLabel="Open…" title="Open a file, search, or a terminal" variant="quiet" align="end">
      {(close) => (
        <div className={styles.addMenu} role="menu" aria-label="Open">
          <Button
            variant="quiet"
            role="menuitem"
            onClick={() => {
              close();
              setQuickOpen(true);
            }}
          >
            <Icon name="file" size={14} />
            <span className={styles.addLabel}>Open file…</span>
            <Kbd>⌘P</Kbd>
          </Button>
          <Button
            variant="quiet"
            role="menuitem"
            onClick={() => {
              close();
              openSearchTab(threadId);
            }}
          >
            <Icon name="search" size={14} />
            <span className={styles.addLabel}>Search in files…</span>
            <Kbd>⌘⇧F</Kbd>
          </Button>
          <Button
            variant="quiet"
            role="menuitem"
            onClick={() => {
              close();
              setDrawerOpen(true);
              void createPty(threadId, 80, 24);
            }}
          >
            <Icon name="terminal" size={14} />
            <span className={styles.addLabel}>New terminal</span>
          </Button>
        </div>
      )}
    </Popover>
  );
}
