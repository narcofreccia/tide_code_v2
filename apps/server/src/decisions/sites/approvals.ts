import { newId as defaultNewId, type ActivityOf, type EventRecord, type Verdict } from "@tide/contracts";
import type { Engine } from "../../orchestration/engine.ts";
import type { Judge } from "../judge.ts";
import { clip, Inflight, recordCommand, usable } from "./siteKit.ts";

export interface ApprovalsSiteOptions {
  engine: Engine;
  judge: Pick<Judge, "ask" | "enabled">;
  grayZone: () => { low: number; high: number };
  now?: () => number;
  newId?: () => string;
  log?: (msg: string, data?: unknown) => void;
}

const INSTRUCTIONS =
  "Is this action routine (read-only, inside the worktree, reversible, the kind the user always allows) or consequential (deletes, pushes, installs, touches files outside the worktree, network side effects, money)?";
const LABELS = { routine: "read-only or reversible, inside the worktree", consequential: "deletes, pushes, installs, leaves the worktree, network or money" };
const PATHLIKE = /^(\/|\.\.?\/|~\/)|\/.+\.\w+$|^\w[\w.-]*\/[\w./-]+$/;

/** Path-like strings anywhere in a tool input (bounded). */
export function pathsOf(input: unknown, out: string[] = [], depth = 0): string[] {
  if (out.length >= 10 || depth > 4) return out;
  if (typeof input === "string") {
    if (input.length <= 300 && !input.includes("\n") && PATHLIKE.test(input) && !out.includes(input)) out.push(input);
  } else if (Array.isArray(input)) {
    for (const v of input) pathsOf(v, out, depth + 1);
  } else if (input !== null && typeof input === "object") {
    for (const v of Object.values(input)) pathsOf(v, out, depth + 1);
  }
  return out;
}

function json(input: unknown): string {
  try {
    return clip(JSON.stringify(input) ?? "", 800);
  } catch {
    return "";
  }
}

/**
 * Site `approvals`: each pending approval is rated routine / consequential once (the badge on the
 * card, Inbox ordering). With the thread's opt-in `autoAllowRoutine`, a routine verdict from Jev at
 * or above the gray zone's `high` accepts the approval; nothing else ever answers on the user's behalf.
 */
export class ApprovalsSite {
  #engine: Engine;
  #judge: ApprovalsSiteOptions["judge"];
  #grayZone: () => { low: number; high: number };
  #now: () => number;
  #newId: () => string;
  #log: (msg: string, data?: unknown) => void;
  #seen = new Set<string>();
  #inflight = new Inflight();
  #unsubscribe: (() => void) | undefined;

  constructor(options: ApprovalsSiteOptions) {
    this.#engine = options.engine;
    this.#judge = options.judge;
    this.#grayZone = options.grayZone;
    this.#now = options.now ?? Date.now;
    this.#newId = options.newId ?? defaultNewId;
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
  }

  start(): void {
    this.#unsubscribe ??= this.#engine.subscribe((record) => this.#onRecord(record));
  }

  stop(): void {
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
  }

  async drain(): Promise<void> {
    for (let i = 0; i < 1_000; i++) {
      await this.#engine.drain();
      if (this.#inflight.size === 0) return;
      await this.#inflight.all();
    }
    throw new Error("approvals site did not drain");
  }

  #onRecord(record: EventRecord): void {
    const event = record.event;
    if (event.type !== "activity.upserted") return;
    const a = event.activity;
    if (a.kind !== "approval" || a.status !== "pending" || this.#seen.has(a.id)) return;
    try {
      if (!this.#judge.enabled("approvals")) return;
      this.#seen.add(a.id);
      this.#inflight.track(this.#rate(a));
    } catch (err) {
      this.#log("[approvals] trigger failed", err);
    }
  }

  async #rate(a: ActivityOf<"approval">): Promise<void> {
    try {
      const thread = this.#engine.getModel().threads[a.threadId];
      const [verdict] = await this.#judge.ask({
        site: "approvals",
        id: `approval:${a.id}`,
        kind: "label",
        state: {
          toolName: a.toolName,
          ...(a.title !== undefined ? { title: clip(a.title, 300) } : {}),
          ...(a.description !== undefined ? { description: clip(a.description, 400) } : {}),
          input: json(a.input),
          ...(a.diff !== undefined ? { diffHead: a.diff.split("\n").slice(0, 40).join("\n") } : {}),
          paths: pathsOf(a.input),
          ...(thread !== undefined ? { thread: clip(thread.title, 120) } : {}),
        },
        instructions: INSTRUCTIONS,
        labels: LABELS,
      });
      const v = usable("approvals", verdict, this.#now());
      if (v?.label === undefined || this.#engine.getModel().activities[a.id] === undefined) return;
      await this.#engine.dispatch(recordCommand("approval", a.id, v));
      await this.#maybeAutoAllow(a.id, v);
    } catch (err) {
      this.#log("[approvals] verdict failed", err);
    }
  }

  /** The three gates: the thread opted in, the verdict is routine from Jev at ≥ high, and it is still pending. */
  async #maybeAutoAllow(activityId: string, v: Verdict): Promise<void> {
    const model = this.#engine.getModel();
    const a = model.activities[activityId];
    if (a?.kind !== "approval" || a.status !== "pending") return;
    if (model.threads[a.threadId]?.autoAllowRoutine !== true) return;
    if (v.label !== "routine" || v.source !== "jev" || v.confidence < this.#grayZone().high) return;
    await this.#engine.dispatch({ type: "approval.respond", threadId: a.threadId, requestId: a.requestId, decision: "accept" });
    const at = this.#now();
    await this.#engine.dispatch({
      type: "activity.upsert",
      activity: { id: this.#newId(), threadId: a.threadId, turnId: a.turnId, kind: "info", text: `Auto-allowed (routine, jev ${v.confidence.toFixed(2)})`, createdAt: at, updatedAt: at },
    });
  }
}
