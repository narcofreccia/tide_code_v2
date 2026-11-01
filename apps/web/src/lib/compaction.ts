import type { Activity } from "@tide/contracts";

/**
 * Context compaction as the drivers report it, harness-agnostic: an info row whose text
 * starts "Compacting conversation…" / "Compacting context" while it runs (Claude, Pi) and
 * "Context compacted" once done (every driver; Claude adds "· 182k → 21k tokens").
 */
export interface Compaction {
  phase: "running" | "done";
  /** what the notice shows: the trigger "(manual)" / "(auto)" moves to the tooltip */
  text: string;
}

const RUNNING = /^Compacting (conversation|context)\b/;
const DONE = /^Context compacted\b/;
const TRIGGER = /\s*\((manual|auto)\)/;

export function compactionOf(activity: Activity): Compaction | undefined {
  if (activity.kind !== "info" || activity.payload !== undefined) return undefined;
  if (DONE.test(activity.text)) return { phase: "done", text: activity.text.replace(TRIGGER, "") };
  if (RUNNING.test(activity.text)) return { phase: "running", text: activity.text };
  return undefined;
}

/** A turn whose prompt is the harness's own `/compact` command (optionally with instructions). */
export function isCompactPrompt(text: string): boolean {
  return /^\/compact(\s|$)/.test(text.trim());
}

export const COMPACTING_LABEL = "Compacting conversation…";
