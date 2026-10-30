import { useEffect, useState } from "react";
import { findConflicts, formatBinding, normalizeEvent } from "../../lib/keybindings.ts";
import { SHORTCUTS, SHORTCUT_GROUPS, bindingEntries, defaultBinding, shortcutKeys, type Shortcut } from "../../lib/shortcuts.ts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import section from "./Section.module.css";
import styles from "./KeyboardSection.module.css";

function save(all: Record<string, string>, id: string, chord: string): void {
  void patchServerSettings({ keybindings: { ...all, [id]: chord } });
}

/**
 * Captures the next chord while `id` is armed. Runs in the capture phase and stops the
 * event so neither the global key map nor Settings' own Esc handler sees it.
 */
function useChordCapture(id: string | null, onChord: (chord: string | "cancel" | "reset") => void): void {
  useEffect(() => {
    if (id === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return onChord("cancel");
      if (event.key === "Backspace") return onChord("reset");
      const chord = normalizeEvent(event);
      // a bare letter would hijack typing; shortcuts need ⌘/Ctrl or ⌥
      if (chord === null || !(event.metaKey || event.ctrlKey || event.altKey)) return;
      onChord(chord);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [id, onChord]);
}

/** Rendered from the same registry `useKeyboardMap` dispatches from; bindings sync through the server's settings. */
export function KeyboardSection() {
  const overrides = useServerSettings((s) => s.settings.keybindings ?? {});
  const [armed, setArmed] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; chord: string } | null>(null);
  const entries = bindingEntries(overrides);

  useChordCapture(armed, (result) => {
    const id = armed;
    if (id === null) return;
    if (result === "cancel") {
      setArmed(null);
    } else if (result === "reset") {
      setArmed(null);
      setPending(null);
      save(overrides, id, "");
    } else {
      setArmed(null);
      setPending({ id, chord: result });
      save(overrides, id, result);
    }
  });

  const conflictsOf = (shortcut: Shortcut) => {
    const entry = entries.find((e) => e.id === shortcut.id);
    if (!entry) return [];
    return findConflicts(entry, entries);
  };

  return (
    <div className={section.section}>
      <div className={section.head}>
        <h3 className={section.title}>Keyboard</h3>
        <Button variant="quiet" disabled={Object.keys(overrides).length === 0} onClick={() => void patchServerSettings({ keybindings: Object.fromEntries(Object.keys(overrides).map((id) => [id, ""])) })}>
          Reset all
        </Button>
      </div>
      <p className={section.note}>
        Rebind captures the next chord: Esc cancels, Backspace restores the default. Bindings sync across the clients of this server.
      </p>
      <table className={section.table}>
        <thead>
          <tr>
            <th scope="col">Shortcut</th>
            <th scope="col">Action</th>
            <th scope="col">Group</th>
            <th scope="col"><span className={styles.sr}>Rebind</span></th>
          </tr>
        </thead>
        <tbody>
          {SHORTCUT_GROUPS.flatMap((group) =>
            SHORTCUTS.filter((s) => s.group === group).map((shortcut) => {
              const fixed = shortcut.run === undefined;
              const conflicts = fixed ? [] : conflictsOf(shortcut);
              const custom = overrides[shortcut.id];
              return (
                <tr key={shortcut.id} data-shortcut={shortcut.id}>
                  <td>
                    {armed === shortcut.id ? (
                      <span className={styles.listening}>Press keys…</span>
                    ) : (
                      <Kbd>{shortcutKeys(shortcut, overrides)}</Kbd>
                    )}
                  </td>
                  <td>
                    {shortcut.label}
                    {conflicts.length > 0 ? (
                      <span className={styles.conflict} role="alert">
                        {formatBinding(entries.find((e) => e.id === shortcut.id)?.binding ?? "")} is also{" "}
                        {conflicts.map((c) => c.label).join(", ")}
                      </span>
                    ) : null}
                    {pending?.id === shortcut.id && conflicts.length === 0 && custom ? (
                      <span className={styles.saved}>saved</span>
                    ) : null}
                  </td>
                  <td className={section.group}>{shortcut.group}</td>
                  <td className={styles.actions}>
                    {fixed ? (
                      <span className={styles.fixed}>fixed</span>
                    ) : (
                      <>
                        <Button
                          variant="quiet"
                          aria-label={`Rebind ${shortcut.label}`}
                          onClick={() => setArmed(armed === shortcut.id ? null : shortcut.id)}
                        >
                          {armed === shortcut.id ? "Cancel" : "Rebind"}
                        </Button>
                        {custom && defaultBinding(shortcut) !== custom ? (
                          <Button variant="quiet" aria-label={`Reset ${shortcut.label}`} onClick={() => save(overrides, shortcut.id, "")}>
                            Reset
                          </Button>
                        ) : null}
                      </>
                    )}
                  </td>
                </tr>
              );
            }),
          )}
        </tbody>
      </table>
    </div>
  );
}
