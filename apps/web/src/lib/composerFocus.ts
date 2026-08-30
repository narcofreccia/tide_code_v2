let focus: (() => void) | undefined;

/** The mounted composer registers itself so cards can hand focus back to it. */
export function registerComposerFocus(fn: () => void): () => void {
  focus = fn;
  return () => {
    if (focus === fn) focus = undefined;
  };
}

export function focusComposer(): void {
  focus?.();
}
