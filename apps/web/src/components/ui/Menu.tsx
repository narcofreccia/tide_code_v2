import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "./useAnchoredPanel.ts";
import styles from "./Menu.module.css";

export interface MenuItem {
  label: string;
  /** omitted on an item that only opens `submenu` */
  onSelect?: () => void;
  disabled?: boolean;
  /** muted text shown inline after the label, e.g. why the item is disabled */
  hint?: string;
  danger?: boolean;
  separatorBefore?: boolean;
  /** a nested list ("Snooze ▸"); choosing the item swaps the menu to it */
  submenu?: MenuItem[];
}

export interface MenuPosition {
  x: number;
  y: number;
}

/**
 * Context menu anchored at a viewport point. Closes on Escape, outside click and
 * after any selection; ↑/↓/Enter walk it for keyboard users.
 */
export function ContextMenu({
  position,
  items,
  onClose,
  label = "Context menu",
}: {
  position: MenuPosition;
  items: MenuItem[];
  onClose: () => void;
  label?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [focused, setFocused] = useState(0);
  const [nested, setNested] = useState<{ label: string; items: MenuItem[] } | undefined>(undefined);
  // clamped to the viewport: a right-click near the bottom edge still shows the menu
  const style = useAnchoredPanel(true, root, root, { point: position, gap: 0 });

  useEffect(() => {
    const onDown = (e: MouseEvent): void => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const shown: MenuItem[] = nested
    ? [{ label: `◂ ${nested.label}`, onSelect: () => setNested(undefined) }, ...nested.items]
    : items;
  const enabled = shown.filter((i) => !i.disabled);

  return createPortal(
    <div
      ref={root}
      className={styles.menu}
      role="menu"
      aria-label={label}
      style={style}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") setFocused((v) => Math.min(enabled.length - 1, v + 1));
        else if (e.key === "ArrowUp") setFocused((v) => Math.max(0, v - 1));
        else return;
        e.preventDefault();
      }}
    >
      {shown.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled === true}
          autoFocus={index === focused}
          {...(item.submenu ? { "aria-haspopup": "menu" as const } : {})}
          className={[styles.item, item.danger ? styles.danger : "", item.separatorBefore ? styles.separated : ""]
            .filter(Boolean)
            .join(" ")}
          onClick={() => {
            if (item.submenu) {
              setNested({ label: item.label, items: item.submenu });
              setFocused(1);
              return;
            }
            if (nested && index === 0) {
              item.onSelect?.();
              setFocused(0);
              return;
            }
            onClose();
            item.onSelect?.();
          }}
        >
          <span className={styles.label}>{item.label}</span>
          {item.hint ? <span className={styles.hint}>{item.hint}</span> : null}
          {item.submenu ? <span className={styles.chevron}>▸</span> : null}
        </button>
      ))}
    </div>,
    document.body,
  );
}
