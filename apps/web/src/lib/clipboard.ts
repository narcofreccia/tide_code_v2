import { create } from "zustand";
import { showToast } from "../state/toast.ts";

/**
 * The hidden-textarea fallback: `navigator.clipboard` exists only in a secure context, so a
 * phone reaching the server over plain-http LAN never has it, but `execCommand("copy")` still
 * works there on most browsers. Focus goes back where it was (the composer keeps its caret).
 */
function execCopy(text: string): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.setAttribute("aria-hidden", "true");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  // iOS Safari ignores select() on a readonly field; an explicit range works there
  area.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  } finally {
    area.remove();
    active?.focus();
  }
  return ok;
}

/** Copies `text`; true only when it really reached the clipboard. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard !== undefined && typeof clipboard.writeText === "function") {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      /* denied (no focus, no permission): try the fallback */
    }
  }
  return execCopy(text);
}

/** The text a failed copy offers for copying by hand; `ManualCopyDialog` shows it. */
export const useManualCopy = create<{ text: string | undefined }>(() => ({ text: undefined }));

export function openManualCopy(text: string): void {
  useManualCopy.setState({ text });
}

export function closeManualCopy(): void {
  useManualCopy.setState({ text: undefined });
}

export const COPY_UNAVAILABLE = "Copying is not available here";

/** The failure toast: says so, and offers the text selected in a dialog. */
export function reportCopyFailure(text: string): void {
  showToast(COPY_UNAVAILABLE, { label: "Show text", onClick: () => openManualCopy(text) });
}

/** Copies and confirms with `success` ("Copied" by default); never claims a copy that did not happen. */
export async function copyWithToast(text: string, success = "Copied"): Promise<boolean> {
  const ok = await copyToClipboard(text);
  if (ok) showToast(success);
  else reportCopyFailure(text);
  return ok;
}

/**
 * Copies text that is still being produced (e.g. after a fetch). WebKit, the desktop shell's
 * engine, drops the click's clipboard permission across an `await`, so where `ClipboardItem`
 * exists the write starts now, inside the gesture, with the text as a pending blob.
 * Resolves to undefined when the text could not be produced (the caller reports that).
 */
export async function copyPendingWithToast(text: Promise<string | undefined>, success = "Copied"): Promise<boolean | undefined> {
  const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
  if (clipboard !== undefined && typeof clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
    const blob = text.then((t) => {
      if (t === undefined) throw new Error("nothing to copy");
      return new Blob([t], { type: "text/plain" });
    });
    try {
      await clipboard.write([new ClipboardItem({ "text/plain": blob })]);
      showToast(success);
      return true;
    } catch {
      /* denied or not produced: fall through to the plain path */
    }
  }
  const resolved = await text.catch(() => undefined);
  if (resolved === undefined) return undefined;
  return copyWithToast(resolved, success);
}
