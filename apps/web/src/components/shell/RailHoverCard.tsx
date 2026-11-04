import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { Thread } from "@tide/contracts";
import { selectThreadMessages, selectWaitingOn } from "@tide/client";
import { formatTokens, formatUsd } from "../../lib/glassBox.ts";
import { mergeTarget } from "../../lib/merge.ts";
import { THREAD_STATE_WORDS, threadStateKey } from "../../lib/vocab.ts";
import { plural } from "../../lib/format.ts";
import { useBackgroundAgentCount } from "../../state/hooks.ts";
import { useModel } from "../../state/model.ts";
import { ThreadGlyph } from "../ui/StatusGlyph.tsx";
import { LAYER_ATTR, useAnchoredPanel } from "../ui/useAnchoredPanel.ts";
import styles from "./RailHoverCard.module.css";

export const HOVER_DELAY_MS = 400;
const SNIPPET_CHARS = 140;

/** True after the pointer rests on `anchor` for 400 ms; any leave, key press, scroll or unmount cancels. */
export function useRestingHover(anchor: RefObject<HTMLElement | null>): boolean {
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const node = anchor.current;
    if (!node) return undefined;
    const cancel = (): void => {
      clearTimeout(timer.current);
      timer.current = undefined;
      setOpen(false);
    };
    const start = (): void => {
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setOpen(true), HOVER_DELAY_MS);
    };
    node.addEventListener("pointerenter", start);
    node.addEventListener("pointerleave", cancel);
    node.addEventListener("pointerdown", cancel);
    window.addEventListener("keydown", cancel, true);
    window.addEventListener("scroll", cancel, true);
    return () => {
      node.removeEventListener("pointerenter", start);
      node.removeEventListener("pointerleave", cancel);
      node.removeEventListener("pointerdown", cancel);
      window.removeEventListener("keydown", cancel, true);
      window.removeEventListener("scroll", cancel, true);
      clearTimeout(timer.current);
    };
  }, [anchor]);
  return open;
}

/** "2 approvals · 1 question · 1 plan", or undefined when nothing waits. */
export function pendingSummary(kinds: readonly string[]): string | undefined {
  const count = (k: string): number => kinds.filter((x) => x === k).length;
  const parts = [
    count("approval") > 0 ? plural(count("approval"), "approval") : "",
    count("question") > 0 ? plural(count("question"), "question") : "",
    count("plan") > 0 ? plural(count("plan"), "plan") : "",
  ].filter(Boolean);
  return parts.length === 0 ? undefined : parts.join(" · ");
}

function Card({ thread, anchor }: { thread: Thread; anchor: RefObject<HTMLElement | null> }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const style = useAnchoredPanel(true, anchor, panelRef, { align: "end", gap: 8, margin: 16 });
  const model = useModel((s) => s.model);
  const background = useBackgroundAgentCount(thread.id);
  const project = model.projects[thread.projectId]?.title;
  const state = threadStateKey(thread, Date.now(), background);
  const messages = selectThreadMessages(model, thread.id);
  const last = messages[messages.length - 1]?.text.trim().replace(/\s+/g, " ");
  const snippet = last === undefined || last === "" ? undefined : last.length > SNIPPET_CHARS ? `${last.slice(0, SNIPPET_CHARS - 1)}…` : last;
  const pending = pendingSummary(selectWaitingOn(model, thread).map((i) => i.attention));
  const ctx = thread.contextUsage;
  const figures = [
    thread.totalCostUsd === undefined ? undefined : formatUsd(thread.totalCostUsd),
    ctx === undefined || ctx.window <= 0 ? undefined : `ctx ${Math.round((ctx.used / ctx.window) * 100)}% · ${formatTokens(ctx.used)}`,
  ].filter(Boolean);
  return createPortal(
    <div ref={panelRef} className={styles.card} style={style} role="tooltip" {...{ [LAYER_ATTR]: "" }}>
      <div className={styles.title}>{thread.title}</div>
      {project === undefined ? null : <div className={styles.muted}>{project}</div>}
      {thread.branch === undefined && thread.baseBranch === undefined ? null : <div className={styles.mono}>{mergeTarget(thread)}</div>}
      <div className={styles.state}>
        <ThreadGlyph thread={thread} />
        <span>{THREAD_STATE_WORDS[state]}</span>
        {pending === undefined ? null : <span className={styles.pending}>{pending}</span>}
      </div>
      {snippet === undefined ? null : <div className={styles.snippet}>{snippet}</div>}
      {figures.length === 0 ? null : <div className={styles.muted}>{figures.join(" · ")}</div>}
    </div>,
    document.body,
  );
}

/** The rail row's hover card: mount once per row; renders nothing until the pointer has rested. */
export function RailHoverCard({ thread, anchor }: { thread: Thread; anchor: RefObject<HTMLElement | null> }) {
  const open = useRestingHover(anchor);
  return open ? <Card thread={thread} anchor={anchor} /> : null;
}
