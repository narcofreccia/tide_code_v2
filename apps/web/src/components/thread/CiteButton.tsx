import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cite } from "../../lib/cite.ts";
import styles from "./CiteButton.module.css";

interface Picked {
  text: string;
  label: string;
  x: number;
  y: number;
}

/** The selection inside one assistant reply (`[data-cite-label]`) of `root`, if any. */
function readSelection(root: HTMLElement): Picked | undefined {
  const selection = typeof window.getSelection === "function" ? window.getSelection() : null;
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const text = selection.toString();
  if (text.trim() === "") return undefined;
  const range = selection.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const element = node instanceof Element ? node : node.parentElement;
  const source = element?.closest<HTMLElement>("[data-cite-label]");
  if (!source || !root.contains(source)) return undefined;
  const rect = typeof range.getBoundingClientRect === "function" ? range.getBoundingClientRect() : undefined;
  return { text, label: source.dataset.citeLabel ?? "", x: rect ? rect.left + rect.width / 2 : 0, y: rect ? rect.top : 0 };
}

/**
 * A floating "Cite" button over a text selection in an assistant reply (code blocks
 * included). Clicking it appends a blockquote to the composer draft.
 */
export function CiteButton({ root }: { root: React.RefObject<HTMLElement | null> }) {
  const [picked, setPicked] = useState<Picked | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const check = (): void => setPicked(readSelection(element));
    const onSelectionChange = (): void => {
      const selection = window.getSelection?.();
      if (!selection || selection.isCollapsed) setPicked(undefined);
    };
    const hide = (): void => setPicked(undefined);
    element.addEventListener("mouseup", check);
    element.addEventListener("keyup", check);
    element.addEventListener("scroll", hide, true);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      element.removeEventListener("mouseup", check);
      element.removeEventListener("keyup", check);
      element.removeEventListener("scroll", hide, true);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [root]);

  // viewport coordinates go in as custom properties, not an inline style object
  useLayoutEffect(() => {
    if (!picked || !button.current) return;
    button.current.style.setProperty("--cite-x", `${Math.round(picked.x)}px`);
    button.current.style.setProperty("--cite-y", `${Math.round(picked.y)}px`);
  }, [picked]);

  if (!picked) return null;
  return (
    <button
      ref={button}
      type="button"
      className={styles.cite}
      title="Quote the selection in the composer"
      // mousedown would collapse the selection before click lands
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        cite(picked.text, picked.label === "" ? undefined : picked.label);
        window.getSelection?.()?.removeAllRanges();
        setPicked(undefined);
      }}
    >
      Cite
    </button>
  );
}
