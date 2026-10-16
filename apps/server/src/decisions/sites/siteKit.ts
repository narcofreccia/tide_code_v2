import type { InternalCommand, JudgeSite, Verdict } from "@tide/contracts";
import type { JudgeVerdict } from "../judge.ts";

export const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max)}…`);

/** The verdict a site persists, or undefined for `none` / errored / labelless answers. */
export function usable(site: JudgeSite, v: JudgeVerdict | undefined, at: number): Verdict | undefined {
  if (v === undefined || v.source === "none" || v.error !== undefined) return undefined;
  return { site, ...(v.label !== undefined ? { label: v.label } : {}), ...(v.score !== undefined ? { score: v.score } : {}), confidence: v.confidence, source: v.source, at };
}

export const recordCommand = (kind: "thread" | "approval" | "experts", id: string, verdict: Verdict): InternalCommand => ({ type: "judge.record", target: { kind, id }, verdict });

/** Tracks in-flight site work so tests and shutdown can await it. */
export class Inflight {
  #set = new Set<Promise<unknown>>();
  track(p: Promise<unknown>): void {
    const t = p.finally(() => this.#set.delete(t));
    this.#set.add(t);
  }
  get size(): number {
    return this.#set.size;
  }
  all(): Promise<unknown> {
    return Promise.allSettled([...this.#set]);
  }
}
