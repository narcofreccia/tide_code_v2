import { useEffect, useRef } from "react";
import type { Thread } from "@tide/contracts";
import { COMPOSE_EVENT, composeIsFor, readComposeDetail, type ComposeDetail } from "../../lib/cite.ts";
import { parseSideCommand } from "../../lib/slash.ts";
import { interruptTurn } from "../../lib/threadActions.ts";
import { showToast } from "../../state/toast.ts";
import { useUi } from "../../state/ui.ts";
import { useWorkbench } from "../../state/workbench.ts";
import { promptOf } from "./useComposerSend.ts";
import { openSideChat } from "./useSideChat.ts";

/**
 * R16: two composers can be mounted at once — the thread's own (`main`) and a side
 * chat's in the workbench (`side`). This is what keeps them out of each other's way.
 */
export type ComposerScope = "main" | "side";

/** Any layer that owns Escape ahead of the thread: dialog, popover, palette, picker. */
function anOverlayIsOpen(): boolean {
  const ui = useUi.getState();
  if (
    ui.paletteOpen ||
    ui.threadDialog !== null ||
    ui.projectDialog !== null ||
    ui.newProjectOpen ||
    ui.newThreadProjectId !== null ||
    ui.linksProjectId !== null ||
    ui.newExpertsProjectId !== null ||
    useWorkbench.getState().quickOpen
  ) {
    return true;
  }
  // Popover panels and modals are portalled and both carry role="dialog"
  return typeof document !== "undefined" && document.querySelector('[role="dialog"]') !== null;
}

/**
 * True while focus sits in the composer or anywhere else in the thread column.
 * Focus nowhere in particular counts too, so Esc still stops the turn before the
 * user has clicked anything; focus in the workbench or a side surface does not.
 */
export function threadColumnHasFocus(composer: HTMLElement | null): boolean {
  if (typeof document === "undefined") return false;
  const active = document.activeElement;
  if (active === null || active === document.body) return true;
  if (!(active instanceof Element)) return false;
  return composer?.contains(active) === true || active.closest("[data-thread-column]") !== null;
}

/** A side composer owns Esc only while it holds the focus itself. */
function ownsEscape(scope: ComposerScope, composer: HTMLElement | null): boolean {
  if (scope === "main") return threadColumnHasFocus(composer);
  const active = typeof document === "undefined" ? null : document.activeElement;
  return active !== null && composer?.contains(active) === true;
}

/** Esc stops the running turn while this composer's surface owns the focus. */
export function useEscInterrupt(root: React.RefObject<HTMLElement | null>, threadId: string, scope: ComposerScope, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (anOverlayIsOpen() || !ownsEscape(scope, root.current)) return;
      e.preventDefault();
      interruptTurn(threadId);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, threadId, scope, root]);
}

/** "Try an example", Cite, Quote and Bring back fill the composer they are meant for; they never send. */
export function useComposeEvent(threadId: string, scope: ComposerScope, onCompose: (detail: ComposeDetail) => void): void {
  const handler = useRef(onCompose);
  handler.current = onCompose;
  useEffect(() => {
    const listener = (e: Event): void => {
      const detail = readComposeDetail((e as CustomEvent<unknown>).detail);
      if (detail && composeIsFor(detail, threadId, scope === "main")) handler.current(detail);
    };
    window.addEventListener(COMPOSE_EVENT, listener);
    return () => window.removeEventListener(COMPOSE_EVENT, listener);
  }, [threadId, scope]);
}

/**
 * `/side <question>` / `/btw <question>`: asks a side chat instead of sending to this
 * thread. True when the text was such a command (handled: the caller does not send).
 * The text leaves the draft; attachments stay in it (side chats take text only).
 */
export function interceptSide(thread: Thread, scope: ComposerScope, text: string, hasAttachments: boolean, clearText: () => void): boolean {
  const side = parseSideCommand(text);
  if (!side) return false;
  if (scope === "side" || thread.role === "side") {
    showToast("Side chats do not nest: ask in the main thread");
    return true;
  }
  clearText();
  void openSideChat(thread.id, promptOf(side.prompt, false, false), { hadAttachments: hasAttachments });
  return true;
}
