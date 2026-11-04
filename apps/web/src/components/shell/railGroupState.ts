import { useCallback, useState } from "react";
import { COLLAPSED_BY_DEFAULT } from "./railGroupModel.ts";

/** Which rail groups the user folded or opened, persisted per group in localStorage. */
export const RAIL_GROUPS_KEY = "tide.rail.groups";

/** keyed by a `RailGroupKey` or `project:<id>` */
type Folds = Record<string, boolean | undefined>;

function read(): Folds {
  try {
    const raw = window.localStorage.getItem(RAIL_GROUPS_KEY);
    const parsed: unknown = raw === null ? {} : JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" ? (parsed as Folds) : {};
  } catch {
    return {};
  }
}

export function isGroupCollapsed(folds: Folds, key: string): boolean {
  return folds[key] ?? COLLAPSED_BY_DEFAULT.has(key);
}

/** The rail's folds: read once on mount, written through on every toggle. */
export function useGroupFolds(): { folds: Folds; toggle: (key: string) => void } {
  const [folds, setFolds] = useState<Folds>(read);
  const toggle = useCallback((key: string) => {
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

/** The Settled group's "merged only" filter, persisted beside the folds. */
export const SETTLED_MERGED_KEY = "tide.rail.settledMergedOnly";

export function useSettledMergedOnly(): [boolean, () => void] {
  const [on, setOn] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(SETTLED_MERGED_KEY) === "1";
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setOn((current) => {
      try {
        window.localStorage.setItem(SETTLED_MERGED_KEY, current ? "0" : "1");
      } catch {
        // storage blocked: the filter still applies for this session
      }
      return !current;
    });
  }, []);
  return [on, toggle];
}
