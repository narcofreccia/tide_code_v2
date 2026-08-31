import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "./Button.tsx";
import { useAnchoredPanel } from "./useAnchoredPanel.ts";
import styles from "./Popover.module.css";

/**
 * Anchored disclosure used by the plan and new-thread pickers. Closes on Escape,
 * on an outside click, and whenever the content calls `close`. The panel is
 * portalled and viewport-clamped so overflow containers cannot clip it.
 */
export function Popover({
  label,
  title,
  variant = "ghost",
  disabled,
  align = "start",
  children,
}: {
  label: React.ReactNode;
  title?: string;
  variant?: "primary" | "ghost" | "quiet";
  disabled?: boolean;
  align?: "start" | "end";
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
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </Button>
      {open
        ? createPortal(
            <div ref={panel} className={styles.panel} style={style} role="dialog">
              {children(() => setOpen(false))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
