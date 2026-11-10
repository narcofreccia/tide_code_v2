import { useCallback } from "react";

/** Arrow keys move a resize handle by this many pixels. */
export const SEPARATOR_STEP_PX = 16;

export interface SeparatorOptions {
  /** current size in the handle's own units (px, or % for a ratio split) */
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  /** one arrow press in the same units; a function when it depends on the layout (a % of the box) */
  step?: number | (() => number);
  /** `vertical` (the default) is a handle between left and right panes: ←/→; `horizontal`: ↑/↓ */
  orientation?: "vertical" | "horizontal";
}

/**
 * Keyboard and ARIA for a `role="separator"` resize handle (WAI-ARIA window splitter): focusable,
 * arrows move it by 16px, Home/End jump to the minimum/maximum. Spread the result on the handle.
 */
export function useSeparatorKeys({ value, min, max, onChange, step = SEPARATOR_STEP_PX, orientation = "vertical" }: SeparatorOptions) {
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      const by = typeof step === "function" ? step() : step;
      const [less, more] = orientation === "vertical" ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"];
      let next: number;
      if (event.key === less) next = value - by;
      else if (event.key === more) next = value + by;
      else if (event.key === "Home") next = min;
      else if (event.key === "End") next = max;
      else return;
      event.preventDefault();
      onChange(Math.min(max, Math.max(min, next)));
    },
    [value, min, max, onChange, step, orientation],
  );
  return {
    role: "separator" as const,
    tabIndex: 0,
    "aria-orientation": orientation,
    "aria-valuenow": Math.round(value),
    "aria-valuemin": min,
    "aria-valuemax": max,
    onKeyDown,
  };
}
