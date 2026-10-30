import { useEffect } from "react";
import type { ReadModel, Thread } from "@tide/contracts";
import { useModel } from "../state/model.ts";
import { useUi } from "../state/ui.ts";
import { useNotifications } from "../state/notifications.ts";
import { notify } from "./notify.ts";

interface Seen {
  status: Thread["status"];
  attention: Thread["attention"];
  limited: boolean;
}

const ATTENTION_BODY: Record<NonNullable<Thread["attention"]>, string> = {
  approval: "Waiting for your approval.",
  question: "Asked you a question.",
  plan: "Proposed a plan.",
};

function snapshot(model: ReadModel): Map<string, Seen> {
  const out = new Map<string, Seen>();
  for (const t of Object.values(model.threads)) {
    out.set(t.id, { status: t.status, attention: t.attention, limited: t.limited !== undefined });
  }
  return out;
}

function watching(thread: Thread): boolean {
  const { selectedThreadId, view } = useUi.getState();
  return typeof document !== "undefined" && document.hasFocus() && view === "thread" && selectedThreadId === thread.id;
}

function fire(thread: Thread, prev: Seen): void {
  if (thread.archivedAt !== undefined) return;
  if (useNotifications.getState().mutedProjectIds.includes(thread.projectId)) return;
  if (watching(thread)) return;
  const send = (kind: string, title: string, body: string): void => {
    void notify({ title, body: body || thread.title, threadId: thread.id, tag: `${thread.id}:${kind}` });
  };
  if (thread.attention && thread.attention !== prev.attention) {
    send(`attention-${thread.attention}`, `Needs you: ${thread.title}`, ATTENTION_BODY[thread.attention]);
  }
  if (thread.limited && !prev.limited) {
    send("limited", `Usage limit: ${thread.title}`, thread.limited.note ?? "The provider reported its usage limit.");
  }
  if (thread.status === "error" && prev.status !== "error") {
    send("error", `Failed: ${thread.title}`, "The turn ended with an error.");
  }
  if (prev.status === "running" && thread.status === "idle" && !thread.attention && !thread.limited) {
    send("finished", `Finished: ${thread.title}`, "The turn is done.");
  }
}

/** Mount once. Diffs thread status/attention/limited between model updates; the first model after (re)connect is a baseline. */
export function useNotificationEvents(): void {
  useEffect(() => {
    let prev: Map<string, Seen> | undefined;
    let prevSeq = 0;
    const step = (): void => {
      const { model, status } = useModel.getState();
      if (status !== "open") {
        prev = undefined;
        return;
      }
      // seq jumping up from an empty model is the initial snapshot arriving, not activity
      if (!prev || (prevSeq === 0 && model.seq > 0)) {
        prev = snapshot(model);
        prevSeq = model.seq;
        return;
      }
      prevSeq = model.seq;
      for (const thread of Object.values(model.threads)) {
        const before = prev.get(thread.id);
        if (before) fire(thread, before);
      }
      prev = snapshot(model);
    };
    step();
    return useModel.subscribe(step);
  }, []);
}
