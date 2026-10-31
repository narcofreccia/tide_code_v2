import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button.tsx";
import { LAYER_ATTR, useAnchoredPanel } from "./useAnchoredPanel.ts";
import styles from "./Popover.module.css";

/**
 * Anchored disclosure used by the plan and new-thread pickers. Closes on Escape,
 * on an outside click, and whenever the content calls `close`. The panel is
 * portalled and viewport-clamped so overflow containers cannot clip it.
 */
export function Popover({
  label,
  title,
  ariaLabel,
  triggerClassName,
  variant = "ghost",
  disabled,
  align = "start",
  flush = false,
  panelClassName,
  children,
}: {
  label: React.ReactNode;
  title?: string;
  /** accessible name of the trigger when `label` is an icon or a lone glyph */
  ariaLabel?: string;
  triggerClassName?: string | undefined;
  variant?: "primary" | "ghost" | "quiet";
  disabled?: boolean;
  align?: "start" | "end";
  /** no padding, wider: the content (a DialogFrame) draws its own layout */
  flush?: boolean;
  /** extra class on the portalled panel: a caller-sized panel (width, max-height) */
  panelClassName?: string | undefined;
  children: (close: () => void) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const style = useAnchoredPanel(open, anchor, panel, { align });

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      // a Select listbox or menu opened from inside the panel lives in its own portal
      if (target instanceof Element && target.closest(`[${LAYER_ATTR}]`)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className={styles.root} ref={anchor}>
      <Button
        variant={variant}
        disabled={disabled}
        {...(title === undefined ? {} : { title })}
        {...(ariaLabel === undefined ? {} : { "aria-label": ariaLabel })}
        className={triggerClassName}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </Button>
      {open
        ? createPortal(
            <div ref={panel} className={[styles.panel, flush ? styles.flush : "", panelClassName ?? ""].filter(Boolean).join(" ")} style={style} role="dialog" data-tide-layer="">
              {children(() => setOpen(false))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
