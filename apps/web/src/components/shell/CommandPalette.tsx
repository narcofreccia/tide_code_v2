import { useMemo, useRef, useState, useEffect } from "react";
import { closePalette, loadRecents, runPaletteItem } from "../../lib/commands.ts";
import { buildPaletteItems, rankPaletteItems, type PaletteItem } from "../../lib/paletteItems.ts";
import { useModel } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";
import { Kbd } from "../ui/Kbd.tsx";
import styles from "./CommandPalette.module.css";

/** `⌘K`: every shortcut action, every navigation target, the thread's own actions. */
export function CommandPalette() {
  const model = useModel((s) => s.model);
  const selectedThreadId = useUi((s) => s.selectedThreadId);
  const selectedProjectId = useUi((s) => s.selectedProjectId);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const recents = useMemo(() => loadRecents(), []);

  useEffect(() => input.current?.focus(), []);

  const items = useMemo(
    () => buildPaletteItems({ model, selectedThreadId, selectedProjectId }),
    [model, selectedThreadId, selectedProjectId],
  );
  const matches = useMemo(() => rankPaletteItems(query, items, recents), [query, items, recents]);
  const at = Math.min(cursor, Math.max(0, matches.length - 1));

  const choose = (item: PaletteItem | undefined): void => {
    if (!item) return;
    runPaletteItem(item);
  };

  return (
    <div className={styles.scrim} onMouseDown={closePalette}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          className={styles.input}
          aria-label="Command"
          placeholder="Run a command, jump to a thread…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") setCursor((v) => Math.min(matches.length - 1, v + 1));
            else if (e.key === "ArrowUp") setCursor((v) => Math.max(0, v - 1));
            else if (e.key === "Enter") choose(matches[at]);
            else if (e.key === "Escape") closePalette();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
        {matches.length === 0 ? <p className={styles.note}>Nothing matches.</p> : null}
        <ul className={styles.list} role="listbox" aria-label="Commands">
          {matches.slice(0, 60).map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={i === at}
                className={`${styles.row} ${i === at ? styles.active : ""}`}
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(item)}
              >
                <span className={styles.group}>{item.group}</span>
                <span className={styles.label}>{item.label}</span>
                {item.detail ? <span className={styles.detail}>{item.detail}</span> : null}
                {item.kbd ? <Kbd>{item.kbd}</Kbd> : null}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Mounted once by the app shell; renders only while the palette is open. */
export function CommandPaletteHost() {
  const open = useUi((s) => s.paletteOpen);
  return open ? <CommandPalette /> : null;
}
