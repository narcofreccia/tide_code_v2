import { useCallback, useState } from "react";
import { COLLAPSED_BY_DEFAULT, type RailGroupKey } from "./railGroupModel.ts";

/** Which rail groups the user folded or opened, persisted per group in localStorage. */
export const RAIL_GROUPS_KEY = "tide.rail.groups";

type Folds = Partial<Record<RailGroupKey, boolean>>;

function read(): Folds {
  try {
    const raw = window.localStorage.getItem(RAIL_GROUPS_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Folds) : {};
  } catch {
    return {};
  }
}

export function isGroupCollapsed(folds: Folds, key: RailGroupKey): boolean {
  return folds[key] ?? COLLAPSED_BY_DEFAULT.has(key);
}

/** The rail's folds: read once on mount, written through on every toggle. */
export function useGroupFolds(): { folds: Folds; toggle: (key: RailGroupKey) => void } {
  const [folds, setFolds] = useState<Folds>(read);
  const toggle = useCallback((key: RailGroupKey) => {
    setFolds((current) => {
      const next = { ...current, [key]: !isGroupCollapsed(current, key) };
      try {
        window.localStorage.setItem(RAIL_GROUPS_KEY, JSON.stringify(next));
      } catch {
        // storage blocked: the fold still applies for this session
      }
      return next;
    });
  }, []);
  return { folds, toggle };
}
