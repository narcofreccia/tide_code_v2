import { fileURLToPath } from "node:url";
import { emptyReadModel, type ReadModel, type Thread, type Turn, type TurnUsage } from "@tide/contracts";
import type { UsageRecord } from "../types.ts";

/** a fake home with redacted logs in each harness's real shape */
export const FIXTURE_HOME = fileURLToPath(new URL("../../../test/fixtures/usage/home", import.meta.url));

export const OCT_19 = Date.parse("2026-10-19T00:00:00.000Z");
export const OCT_21 = Date.parse("2026-10-21T00:00:00.000Z");
export const OCT_31 = Date.parse("2026-10-31T00:00:00.000Z");

export async function collect(it: AsyncIterable<UsageRecord>): Promise<UsageRecord[]> {
  const out: UsageRecord[] = [];
  for await (const r of it) out.push(r);
  return out;
}

export function sum(records: UsageRecord[]): { in: number; out: number; cacheRead: number; cacheWrite: number } {
  const t = { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 };
  for (const r of records) {
    t.in += r.tokens.in;
    t.out += r.tokens.out;
    t.cacheRead += r.tokens.cacheRead;
    t.cacheWrite += r.tokens.cacheWrite;
  }
  return t;
}

export function thread(id: string, patch: Partial<Thread> = {}): Thread {
  return { id, projectId: "p1", title: id, provider: "claude", mode: "auto", interaction: "default", status: "idle", createdAt: 0, updatedAt: 0, ...patch } as Thread;
}

export function turn(id: string, threadId: string, at: number, usage: TurnUsage | undefined, patch: Partial<Turn> = {}): Turn {
  return { id, threadId, status: "completed", requestedAt: at, settledAt: at, ...(usage !== undefined ? { usage } : {}), ...patch } as Turn;
}

export function modelWith(threads: Thread[], turns: Turn[]): ReadModel {
  const m = emptyReadModel();
  for (const t of threads) m.threads[t.id] = t;
  for (const t of turns) m.turns[t.id] = t;
  return m;
}
