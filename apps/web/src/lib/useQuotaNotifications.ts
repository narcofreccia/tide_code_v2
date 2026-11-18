import { useEffect } from "react";
import { limitNeedsUser } from "@tide/client";
import type { QuotaState, ReadModel } from "@tide/contracts";
import { useModel } from "../state/model.ts";
import { useNotifications } from "../state/notifications.ts";
import { useUi } from "../state/ui.ts";
import { notify } from "./notify.ts";

/**
 * R20: two notices no single model event announces on its own.
 * - A quota going to `warning` or `exceeded`, once per scope per window and status.
 * - A limited thread with the `manual` policy whose window reopened: the reset passing is no
 *   event, so a ticker looks again every `TICK_MS`. Once per limit.
 * Both respect the muted projects of Settings › Notifications. What is already true when the
 * first model arrives is a baseline, as in `useNotificationEvents`.
 */
export const TICK_MS = 30_000;

export interface Notice {
  /** dedupe key: fires once per hook lifetime */
  key: string;
  projectId: string;
  title: string;
  body: string;
  threadId?: string;
}

function quotaNotice(scope: "project" | "thread", id: string, title: string, projectId: string, state: QuotaState, onExceed: "warn" | "hold"): Notice | undefined {
  if (state.status === "ok") return undefined;
  const key = `quota:${scope}:${id}:${state.windowEndsAt ?? "-"}:${state.status}`;
  const base = { key, projectId, ...(scope === "thread" ? { threadId: id } : {}) };
  if (state.status === "warning") {
    return { ...base, title: `${title} is at ${Math.round(state.usedPct)}% of its quota`, body: "New turns still run." };
  }
  return {
    ...base,
    title: `${title} reached its quota`,
    body: onExceed === "hold" ? "New turns wait until the quota resets or you lift it." : "Nothing is held. The quota is set to warn only.",
  };
}

/** Every notice the model calls for right now (the caller drops the ones already fired). */
export function currentNotices(model: ReadModel, now: number): Notice[] {
  const out: Notice[] = [];
  for (const p of Object.values(model.projects)) {
    if (p.archivedAt !== undefined || p.quota === undefined || p.quotaState === undefined) continue;
    const n = quotaNotice("project", p.id, p.title, p.id, p.quotaState, p.quota.onExceed);
    if (n) out.push(n);
  }
  for (const t of Object.values(model.threads)) {
    if (t.archivedAt !== undefined) continue;
    if (t.quota !== undefined && t.quotaState !== undefined) {
      const n = quotaNotice("thread", t.id, t.title, t.projectId, t.quotaState, t.quota.onExceed);
      if (n) out.push(n);
    }
    if (t.limited !== undefined && limitNeedsUser(model, t, now)) {
      out.push({
        key: `limit-ready:${t.id}:${t.limited.at}`,
        projectId: t.projectId,
        threadId: t.id,
        title: `Limit reset: ${t.title}`,
        body: "The usage window reopened. Continue when you are ready.",
      });
    }
  }
  return out;
}

function watching(threadId: string | undefined): boolean {
  if (threadId === undefined) return false;
  const { selectedThreadId, view } = useUi.getState();
  return typeof document !== "undefined" && document.hasFocus() && view === "thread" && selectedThreadId === threadId;
}

/** Mount once (`useNotificationEvents` does). */
export function useQuotaNotifications(): void {
  useEffect(() => {
    const fired = new Set<string>();
    let baselined = false;
    const step = (): void => {
      const { model, status } = useModel.getState();
      if (status !== "open" || model.seq === 0) {
        // the first model after a reconnect is a baseline again
        if (status !== "open") baselined = false;
        return;
      }
      const notices = currentNotices(model, Date.now());
      if (!baselined) {
        baselined = true;
        for (const n of notices) fired.add(n.key);
        return;
      }
      for (const n of notices) {
        if (fired.has(n.key)) continue;
        fired.add(n.key);
        if (useNotifications.getState().mutedProjectIds.includes(n.projectId) || watching(n.threadId)) continue;
        void notify({ title: n.title, body: n.body, tag: n.key, ...(n.threadId === undefined ? {} : { threadId: n.threadId }) });
      }
    };
    step();
    const unsubscribe = useModel.subscribe(step);
    const timer = setInterval(step, TICK_MS);
    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, []);
}
