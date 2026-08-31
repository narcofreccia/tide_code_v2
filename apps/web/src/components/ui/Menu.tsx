import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPanel } from "./useAnchoredPanel.ts";
import styles from "./Menu.module.css";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
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

  const enabled = items.filter((i) => !i.disabled);

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
      {items.map((item, index) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          disabled={item.disabled === true}
          autoFocus={index === focused}
          className={[styles.item, item.danger ? styles.danger : "", item.separatorBefore ? styles.separated : ""]
            .filter(Boolean)
            .join(" ")}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>,
    document.body,
  );
}
