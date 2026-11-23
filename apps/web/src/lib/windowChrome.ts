import { splashBaseFor, type DesktopPlatform } from "./bootstrap.ts";

/**
 * Window chrome the desktop shell leaves to the page, without Tauri imports.
 *
 * On Windows the main window is frameless (one bar: the app's top bar), so the page draws
 * minimise / maximise / close and asks the shell to act through the shell's own scheme,
 * `POST <shell origin>/window/<action>` (`apps/desktop/src-tauri/src/window_controls.rs`),
 * the same channel the splash actions use.
 */

export type WindowAction = "minimize" | "toggle-maximize" | "close";

/** Where WebView2 serves the shell's scheme when the page is not on the app origin (vite dev). */
const WINDOWS_SHELL_BASE = "http://tide-shell.localhost/";

/** The platform `applyDesktopFlag` stamped on `<html>`, or `null` in a plain browser. */
export function desktopPlatform(root: HTMLElement = document.documentElement): DesktopPlatform | null {
  const value = root.dataset.desktop;
  return value === "mac" || value === "win" || value === "linux" ? value : null;
}

/** The shell route for an action, on the shell origin derived from the page's own origin. */
export function windowActionUrl(action: WindowAction, location: { protocol: string; href: string }): string {
  return `${splashBaseFor(location) ?? WINDOWS_SHELL_BASE}window/${action}`;
}

/**
 * Fire and forget. The response is never read, so a `no-cors` request is enough (no CORS
 * headers needed on the shell side); a failure, sync or async, is swallowed.
 */
export function sendWindowAction(
  action: WindowAction,
  location: { protocol: string; href: string } = window.location,
  fetchImpl: typeof fetch = globalThis.fetch,
): void {
  try {
    fetchImpl(windowActionUrl(action, location), { method: "POST", mode: "no-cors", cache: "no-store", credentials: "omit" }).catch(
      () => {},
    );
  } catch {
    /* no fetch, or a refused URL: the button does nothing */
  }
}

// ---- scrollbars ----

/** Width a scrollbar takes from the layout: 0 for overlay scrollbars (macOS, phones). */
export function measureScrollbarWidth(doc: Document = document): number {
  const probe = doc.createElement("div");
  probe.style.cssText = "position:absolute;top:-200px;left:0;width:100px;height:100px;overflow:scroll;visibility:hidden";
  doc.body.appendChild(probe);
  const width = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return width;
}

/**
 * Stamps `data-scrollbars="classic"` on `<html>` when scrollbars take layout space (Windows,
 * Linux, macOS set to always show them); `global.css` thins and tints those. Overlay
 * scrollbars are left as the system draws them.
 */
export function applyScrollbarFlag(width: number = measureScrollbarWidth(), root: HTMLElement = document.documentElement): boolean {
  const classic = width > 0;
  if (classic) root.dataset.scrollbars = "classic";
  else delete root.dataset.scrollbars;
  return classic;
}
