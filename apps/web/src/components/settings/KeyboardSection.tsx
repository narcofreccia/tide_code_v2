import { useEffect, useState } from "react";
import { findConflicts, formatBinding, normalizeEvent } from "../../lib/keybindings.ts";
import { SHORTCUTS, SHORTCUT_GROUPS, bindingEntries, defaultBinding, shortcutKeys, type Shortcut } from "../../lib/shortcuts.ts";
import { patchServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { Button } from "../ui/Button.tsx";
import { Kbd } from "../ui/Kbd.tsx";
import type { SectionMeta } from "./search.ts";
import { SettingsGroup } from "./ui/SettingsGroup.tsx";
import { SettingsPage } from "./ui/SettingsPage.tsx";
import { rowId } from "./ui/saved.ts";
import ui from "./ui/settings.module.css";
import styles from "./KeyboardSection.module.css";

export const META: SectionMeta = {
  title: "Keyboard",
  blurb: "Every shortcut Tide answers to. Bindings sync across the clients of this server.",
  keywords: [...SHORTCUTS.map((s) => s.label), "Rebind", "shortcut", "keybinding"],
};

function save(all: Record<string, string>, id: string, chord: string): void {
  void patchServerSettings({ keybindings: { ...all, [id]: chord } });
}

type CaptureMode = "modified" | "bare" | "sequence";

const SEQUENCE_WINDOW_MS = 1000;

/** What an armed entry accepts: rail keys take a bare key, "Go to" a two-key sequence, the rest ⌘/Ctrl/⌥ chords. */
function captureMode(shortcut: Shortcut): CaptureMode {
  if (shortcut.group === "Go to") return "sequence";
  return shortcut.when === "rail" ? "bare" : "modified";
}

/**
 * Captures the next chord while `id` is armed. Runs in the capture phase and stops the
 * event so neither the global key map nor Settings' own Esc handler sees it.
 */
function useChordCapture(id: string | null, mode: CaptureMode, onChord: (chord: string | "cancel" | "reset") => void): void {
  useEffect(() => {
    if (id === null) return;
    let first: string | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clear = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      first = null;
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return onChord("cancel");
      if (event.key === "Backspace") return onChord("reset");
      const chord = normalizeEvent(event);
      if (chord === null) return;
      const modified = event.metaKey || event.ctrlKey || event.altKey;
      if (mode === "modified") {
        // a bare letter would hijack typing; shortcuts need ⌘/Ctrl or ⌥
        if (modified) onChord(chord);
        return;
      }
      if (modified) return;
      if (mode === "bare") return onChord(chord);
      // sequence: first key arms, second saves "g x" within the window
      if (first === null) {
        first = chord;
        timer = setTimeout(clear, SEQUENCE_WINDOW_MS);
        return;
      }
      const done = `${first} ${chord}`;
      clear();
      onChord(done);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      clear();
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [id, mode, onChord]);
}

/** `G then M` renders as two keys; everything else as one. */
function Keys({ label }: { label: string }) {
  const parts = label.split(" then ");
  if (parts.length < 2) return <Kbd>{label}</Kbd>;
  return (
    <span className={styles.sequence}>
      {parts.map((part, i) => (
        <Kbd key={i}>{part}</Kbd>
      ))}
    </span>
  );
}

/** Rendered from the same registry `useKeyboardMap` dispatches from; bindings sync through the server's settings. */
export function KeyboardSection() {
  const overrides = useServerSettings((s) => s.settings.keybindings ?? {});
  const [armed, setArmed] = useState<string | null>(null);
  const [pending, setPending] = useState<{ id: string; chord: string } | null>(null);
  const entries = bindingEntries(overrides);

  const armedShortcut = SHORTCUTS.find((x) => x.id === armed);
  useChordCapture(armed, armedShortcut ? captureMode(armedShortcut) : "modified", (result) => {
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
    <SettingsPage title={META.title} blurb={META.blurb}>
      <SettingsGroup
        title="Shortcuts"
        help="Rebind captures the next chord (Go to: two keys within a second). Esc cancels, Backspace restores the default."
        actions={
          <Button
            variant="quiet"
            disabled={Object.keys(overrides).length === 0}
            onClick={() => void patchServerSettings({ keybindings: Object.fromEntries(Object.keys(overrides).map((id) => [id, ""])) })}
          >
            Reset all
          </Button>
        }
      >
        <table className={ui.table}>
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
                  <tr key={shortcut.id} id={rowId(shortcut.label)} data-shortcut={shortcut.id}>
                    <td>
                      {armed === shortcut.id ? (
                        <span className={styles.listening}>Press keys…</span>
                      ) : (
                        <Keys label={shortcutKeys(shortcut, overrides)} />
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
                    <td className={ui.label}>{shortcut.group}</td>
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
      </SettingsGroup>
    </SettingsPage>
  );
}
