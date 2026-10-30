import { useState } from "react";
import { regenerateTitles, settleThreads, snoozeThreads } from "../../lib/inboxActions.ts";
import { tomorrowMorning } from "../../lib/turnActions.ts";
import { useModel } from "../../state/model.ts";
import { clearRailSelection, useRailSelection } from "../../state/railSelection.ts";
import { Button } from "../ui/Button.tsx";
import { ContextMenu, type MenuPosition } from "../ui/Menu.tsx";
import styles from "./RailSelectionBar.module.css";

const HOUR = 3_600_000;

/** "3 selected · Settle · Snooze ▾ · Regenerate titles · ✕": bulk actions over the rail's selection. */
export function RailSelectionBar() {
  const picked = useRailSelection((s) => s.ids);
  // a selected thread that was deleted meanwhile drops out
  const ids = useModel((s) => picked.filter((id) => s.model.threads[id] !== undefined).join("\n"));
  const [snooze, setSnooze] = useState<MenuPosition | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const list = ids === "" ? [] : ids.split("\n");
  if (list.length === 0) return null;

  const run = (action: (ids: string[]) => Promise<void>, clear = true): void => {
    setBusy(true);
    void action(list).finally(() => {
      setBusy(false);
      if (clear) clearRailSelection();
    });
  };

  return (
    <div className={styles.bar} role="toolbar" aria-label="Selected threads">
      <span className={styles.count}>{list.length} selected</span>
      <Button variant="quiet" disabled={busy} onClick={() => run(settleThreads)}>
        Settle
      </Button>
      <Button
        variant="quiet"
        disabled={busy}
        aria-haspopup="menu"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setSnooze({ x: rect.left, y: rect.bottom });
        }}
      >
        Snooze ▾
      </Button>
      <Button
        variant="quiet"
        disabled={busy}
        title="A fresh title per thread from your text generation model (Settings › Inbox)"
        onClick={() => run(regenerateTitles, false)}
      >
        {busy ? "Working…" : "Regenerate titles"}
      </Button>
      <button type="button" className={styles.close} aria-label="Clear selection" title="Clear selection (Esc)" onClick={clearRailSelection}>
        ✕
      </button>
      {snooze ? (
        <ContextMenu
          position={snooze}
          label="Snooze selected"
          onClose={() => setSnooze(undefined)}
          items={[
            { label: "1 hour", onSelect: () => run((xs) => snoozeThreads(xs, Date.now() + HOUR)) },
            { label: "Until tomorrow 09:00", onSelect: () => run((xs) => snoozeThreads(xs, tomorrowMorning())) },
          ]}
        />
      ) : null}
    </div>
  );
}
