import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from "react";

export interface AnchorPoint {
  x: number;
  y: number;
}

export interface AnchoredPanelOptions {
  /** which edge of the anchor the panel lines up with */
  align?: "start" | "end";
  /** gap between anchor and panel, px */
  gap?: number;
  /** the panel is at least as wide as its anchor (listboxes) */
  matchAnchorWidth?: boolean;
  /** anchor at a viewport point instead of an element (context menus) */
  point?: AnchorPoint | undefined;
}

/** Keeps popovers off the very edge of the window. */
const MARGIN = 8;
const HIDDEN: CSSProperties = { position: "fixed", top: 0, left: 0, visibility: "hidden" };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * Positions a portalled panel in viewport coordinates: `position: fixed`, so no
 * `overflow: hidden` ancestor can clip it, clamped to the window and flipped
 * above the anchor when there is more room there. Returns the style to spread
 * onto the panel; it stays hidden until the first measurement lands.
 */
export function useAnchoredPanel(
  open: boolean,
  anchor: RefObject<HTMLElement | null>,
  panel: RefObject<HTMLElement | null>,
  options: AnchoredPanelOptions = {},
): CSSProperties {
  const { align = "start", gap = 4, matchAnchorWidth = false, point } = options;
  const pointX = point?.x;
  const pointY = point?.y;
  const [style, setStyle] = useState<CSSProperties>(HIDDEN);

  const place = useCallback((): void => {
    const node = panel.current;
    if (!node) return;
    const rect =
      pointX === undefined || pointY === undefined
        ? anchor.current?.getBoundingClientRect()
        : { top: pointY, bottom: pointY, left: pointX, right: pointX, width: 0 };
    if (!rect) return;

    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const width = node.offsetWidth;
    const height = node.offsetHeight;
    const roomBelow = viewportH - rect.bottom - gap - MARGIN;
    const roomAbove = rect.top - gap - MARGIN;
    const flip = height > roomBelow && roomAbove > roomBelow;
    const maxHeight = Math.max(120, Math.floor(flip ? roomAbove : roomBelow));
    const shown = Math.min(height, maxHeight);

    const top = flip ? rect.top - gap - shown : rect.bottom + gap;
    const left = align === "end" ? rect.right - width : rect.left;
    setStyle({
      position: "fixed",
      top: clamp(top, MARGIN, viewportH - shown - MARGIN),
      left: clamp(left, MARGIN, viewportW - width - MARGIN),
      maxHeight,
      ...(matchAnchorWidth ? { minWidth: rect.width } : {}),
    });
  }, [align, anchor, gap, matchAnchorWidth, panel, pointX, pointY]);

  useLayoutEffect(() => {
    if (!open) {
      setStyle(HIDDEN);
      return undefined;
    }
    place();
    window.addEventListener("resize", place);
    // capture: an ancestor scrolling moves the anchor without bubbling to window
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  return style;
}
