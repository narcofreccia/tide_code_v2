import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fuzzyRank } from "../../lib/fuzzy.ts";
import { useAnchoredPanel } from "./useAnchoredPanel.ts";
import styles from "./Select.module.css";

export interface SelectOption<T extends string> {
  value: T;
  label?: string;
  /** muted second line in the list */
  description?: string;
  disabled?: boolean;
  /** tooltip, used for the "not installed / not logged in" hint */
  title?: string;
  /** optgroup header; consecutive options sharing one are listed under it */
  group?: string;
  icon?: React.ReactNode;
}

/** Above this many options the filter box appears without asking. */
const SEARCH_THRESHOLD = 8;
const TYPEAHEAD_MS = 700;

function normalize<T extends string>(option: T | SelectOption<T>): SelectOption<T> {
  return typeof option === "string" ? { value: option } : option;
}

function labelOf<T extends string>(option: SelectOption<T>): string {
  return option.label ?? option.value;
}

/** Next selectable index walking `step` at a time, wrapping at the ends. */
function step<T extends string>(items: SelectOption<T>[], from: number, delta: number): number {
  if (items.length === 0) return -1;
  for (let i = 1; i <= items.length; i += 1) {
    const index = (from + delta * i + items.length * i) % items.length;
    if (!items[index]?.disabled) return index;
  }
  return from;
}

function firstEnabled<T extends string>(items: SelectOption<T>[]): number {
  const index = items.findIndex((o) => !o.disabled);
  return index;
}

/**
 * Listbox in a portal: `position: fixed` and viewport-clamped, so the top bar's
 * and dialogs' overflow can never clip it. Same public shape as the native
 * wrapper it replaced — `variant`/`size`/`searchable` are the only additions.
 */
export function Select<T extends string>({
  label,
  value,
  options,
  onSelect,
  disabled,
  className,
  size = "sm",
  variant = "pill",
  searchable,
  placeholder = "Select…",
  align = "start",
}: {
  label: string;
  value: T;
  options: readonly (T | SelectOption<T>)[];
  onSelect: (value: T) => void;
  disabled?: boolean | undefined;
  className?: string | undefined;
  size?: "sm" | "md" | undefined;
  variant?: "pill" | "field" | undefined;
  searchable?: boolean | undefined;
  placeholder?: string | undefined;
  align?: "start" | "end" | undefined;
}) {
  const all = useMemo(() => options.map(normalize), [options]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const listId = useId();

  const withFilter = searchable ?? all.length > SEARCH_THRESHOLD;
  const visible = useMemo(() => {
    if (!withFilter || query.trim() === "") return all;
    return fuzzyRank(query.trim(), all, labelOf, all.length).map((r) => r.item);
  }, [all, query, withFilter]);

  const selected = all.find((o) => o.value === value);
  const panelStyle = useAnchoredPanel(open, trigger, panel, { align, matchAnchorWidth: true });

  const close = (focusTrigger = true): void => {
    setOpen(false);
    setQuery("");
    if (focusTrigger) trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (trigger.current?.contains(target) || panel.current?.contains(target)) return;
      setOpen(false);
      setQuery("");
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const index = visible.findIndex((o) => o.value === value);
    setActive(index === -1 ? firstEnabled(visible) : index);
    // focus the panel so the keyboard handler below gets the keys
    (panel.current?.querySelector("input") ?? panel.current)?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on open
  }, [open]);

  const commit = (option: SelectOption<T> | undefined): void => {
    if (!option || option.disabled) return;
    onSelect(option.value);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => step(visible, i, e.key === "ArrowDown" ? 1 : -1));
      return;
    }
    if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setActive(e.key === "Home" ? firstEnabled(visible) : step(visible, 0, -1));
      return;
    }
    if (e.key === "Enter" || (e.key === " " && !withFilter)) {
      e.preventDefault();
      commit(visible[active]);
      return;
    }
    if (e.key === "Tab") {
      close(false);
      return;
    }
    if (withFilter || e.key.length !== 1 || e.metaKey || e.ctrlKey) return;
    const now = Date.now();
    typed.current = {
      text: (now - typed.current.at < TYPEAHEAD_MS ? typed.current.text : "") + e.key.toLowerCase(),
      at: now,
    };
    const hit = visible.findIndex((o) => !o.disabled && labelOf(o).toLowerCase().startsWith(typed.current.text));
    if (hit !== -1) setActive(hit);
  };

  const list: React.ReactNode[] = [];
  let group: string | undefined;
  visible.forEach((option, index) => {
    if (option.group !== undefined && option.group !== group) {
      group = option.group;
      list.push(
        <li key={`group:${option.group}`} role="presentation" className={styles.group}>
          {option.group}
        </li>,
      );
    }
    list.push(
      <li
        key={option.value}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled === true}
        {...(option.title === undefined ? {} : { title: option.title })}
        className={[
          styles.option,
          index === active ? styles.active : "",
          option.value === value ? styles.selected : "",
          option.disabled ? styles.disabledOption : "",
        ]
          .filter(Boolean)
          .join(" ")}
        onMouseEnter={() => setActive(index)}
        onClick={() => commit(option)}
      >
        {option.icon === undefined ? null : <span className={styles.icon}>{option.icon}</span>}
        <span className={styles.optionText}>
          <span className={styles.optionLabel}>{labelOf(option)}</span>
          {option.description === undefined ? null : (
            <span className={styles.description}>{option.description}</span>
          )}
        </span>
        <span className={styles.check} aria-hidden="true">
          {option.value === value ? "✓" : ""}
        </span>
      </li>,
    );
  });

  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={label}
        disabled={disabled}
        className={[styles.trigger, styles[variant], styles[size], className].filter(Boolean).join(" ")}
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (open || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
          e.preventDefault();
          setOpen(true);
        }}
      >
        <span className={styles.value}>{selected ? labelOf(selected) : placeholder}</span>
        <span className={styles.chevron} aria-hidden="true">
          ▾
        </span>
      </button>
      {open
        ? createPortal(
            <div
              ref={panel}
              className={styles.panel}
              style={panelStyle}
              tabIndex={-1}
              onKeyDown={onKeyDown}
            >
              {withFilter ? (
                <input
                  className={styles.filter}
                  aria-label={`Filter ${label}`}
                  placeholder="Filter…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                />
              ) : null}
              <ul
                id={listId}
                className={styles.list}
                role="listbox"
                aria-label={label}
                aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
              >
                {list.length === 0 ? <li className={styles.empty}>No matches</li> : list}
              </ul>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
