import { createContext, useContext } from "react";
import { useServerSettings } from "../../../state/serverSettings.ts";

/** A control's change handler: a returned promise is a server patch whose outcome the group reports. */
export type ChangeResult = void | Promise<unknown>;

type Flash = () => void;

export const SavedContext = createContext<Flash | null>(null);

/**
 * Runs a change and, when it returns a promise, flashes "Saved" in the enclosing group once the
 * server stored it. `patchServerSettings` puts the previous settings object back on a refusal
 * (and toasts), so "the settings object changed" is exactly "the server answered with new settings".
 */
export function useTrackSave(): (run: () => ChangeResult) => void {
  const flash = useContext(SavedContext);
  return (run) => {
    const before = useServerSettings.getState().settings;
    const result = run();
    if (flash === null || !(result instanceof Promise)) return;
    void result.then(
      () => {
        if (useServerSettings.getState().settings !== before) flash();
      },
      () => undefined,
    );
  };
}

/** Stable DOM id for a row, so settings search can scroll to it. */
export function rowId(label: string): string {
  return `setting-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
}
