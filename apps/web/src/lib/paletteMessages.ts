import type { ReadModel, SearchHit } from "@tide/contracts";
import type { PaletteItem } from "./paletteItems.ts";
import { rememberScroll } from "./scrollMemory.ts";
import { SCROLL_TO_EVENT } from "../components/thread/useStreamScroll.ts";
import { useUi } from "../state/ui.ts";

/** Opens a thread scrolled to one message (same thread: scrolls in place). */
export function openThreadAt(threadId: string, messageId: string | undefined): void {
  const ui = useUi.getState();
  if (messageId === undefined) {
    ui.selectThread(threadId);
    return;
  }
  if (ui.view === "thread" && ui.selectedThreadId === threadId) {
    window.dispatchEvent(new CustomEvent(SCROLL_TO_EVENT, { detail: { threadId, rowKey: messageId } }));
    return;
  }
  rememberScroll(threadId, { entryId: "", rowKey: messageId, offsetWithinEntry: 0, atEnd: false });
  ui.selectThread(threadId);
}

/** Message-text hits as palette rows, in the server's (newest first) order. */
export function messageHitItems(model: ReadModel, hits: readonly SearchHit[]): PaletteItem[] {
  return hits
    .filter((h) => h.field === "message")
    .map((hit) => {
      const project = model.projects[hit.projectId]?.title;
      return {
        id: `message:${hit.threadId}:${hit.messageId ?? hit.at}`,
        label: hit.snippet,
        group: "In messages" as const,
        detail: project === undefined ? hit.title : `${hit.title} · ${project}`,
        run: () => openThreadAt(hit.threadId, hit.messageId),
      };
    });
}
