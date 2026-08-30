import { useEffect, useRef, useState } from "react";
import { Button } from "./Button.tsx";
import styles from "./Popover.module.css";

/**
 * Anchored disclosure used by the plan and new-thread pickers. Closes on Escape,
 * on an outside click, and whenever the content calls `close`.
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
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) setOpen(false);
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
    <div className={styles.root} ref={root}>
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
      {open ? (
        <div className={`${styles.panel} ${align === "end" ? styles.end : ""}`} role="dialog">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
