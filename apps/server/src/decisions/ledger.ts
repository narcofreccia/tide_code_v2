import { randomUUID } from "node:crypto";
import type { DecisionsStats, JudgeSite, JudgeSource } from "@tide/contracts";
import type { SqlStatement } from "../db/sqlite.ts";
import type { EventStore } from "../orchestration/store.ts";
import type { JudgeVerdict, LedgerSink } from "./judge.ts";

/**
 * Every verdict the judge produced, for spend and observability (`decisions.stats`). A side
 * table in the event-store database; never part of the event log or the read model. Jev rows of
 * one request share a `call_id` and split its tokens/cost, so sums are exact and calls countable.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS judge_ledger (
  id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  site TEXT NOT NULL,
  source TEXT NOT NULL,
  model TEXT,
  question_id TEXT NOT NULL,
  label TEXT,
  score REAL,
  confidence REAL NOT NULL,
  input_tokens INTEGER NOT NULL,
  cost_usd REAL,
  elapsed_ms INTEGER NOT NULL,
  error TEXT,
  call_id TEXT
);
CREATE INDEX IF NOT EXISTS judge_ledger_at_idx ON judge_ledger(at);
`;

export type LedgerEntry = JudgeVerdict & { site: JudgeSite; at: number };
type Bucket = DecisionsStats["today"]["jev"];

/** Local midnight of the day containing `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

const opt = <T>(v: unknown, map: (v: unknown) => T): T | undefined => (v === null || v === undefined ? undefined : map(v));

export class JudgeLedger implements LedgerSink {
  #insert: SqlStatement;
  #jevToday: SqlStatement;
  #fallbackToday: SqlStatement;
  #bySite: SqlStatement;
  #recent: SqlStatement;

  constructor(store: Pick<EventStore, "sideTable">) {
    const db = store.sideTable(DDL);
    this.#insert = db.prepare(
      "INSERT INTO judge_ledger (id, at, site, source, model, question_id, label, score, confidence, input_tokens, cost_usd, elapsed_ms, error, call_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const bucket = "COUNT(DISTINCT COALESCE(call_id, id)) AS calls, COALESCE(SUM(input_tokens), 0) AS tokens, COALESCE(SUM(cost_usd), 0) AS usd";
    this.#jevToday = db.prepare(`SELECT ${bucket} FROM judge_ledger WHERE at >= ? AND call_id IS NOT NULL`);
    this.#fallbackToday = db.prepare(`SELECT ${bucket} FROM judge_ledger WHERE at >= ? AND source = 'fallback'`);
    this.#bySite = db.prepare(`SELECT site, ${bucket} FROM judge_ledger WHERE at >= ? AND (call_id IS NOT NULL OR source = 'fallback') GROUP BY site`);
    this.#recent = db.prepare("SELECT * FROM judge_ledger ORDER BY at DESC, rowid DESC LIMIT ?");
  }

  record(v: LedgerEntry): void {
    this.#insert.run(
      randomUUID(),
      Math.round(v.at),
      v.site,
      v.source,
      v.model ?? null,
      v.id,
      v.label ?? null,
      v.score ?? null,
      v.confidence,
      Math.round(v.tokens),
      v.costUsd ?? null,
      Math.round(v.elapsedMs),
      v.error ?? null,
      v.callId ?? null,
    );
  }

  statsToday(now: number): Pick<DecisionsStats, "today" | "bySite"> {
    const since = startOfDay(now);
    const toBucket = (row: Record<string, unknown> | undefined): Bucket => ({ calls: Number(row?.["calls"] ?? 0), tokens: Number(row?.["tokens"] ?? 0), usd: Number(row?.["usd"] ?? 0) });
    const bySite: Record<string, Bucket> = {};
    for (const row of this.#bySite.all(since)) bySite[String(row["site"])] = toBucket(row);
    return { today: { jev: toBucket(this.#jevToday.get(since)), fallback: toBucket(this.#fallbackToday.get(since)) }, bySite };
  }

  recent(limit = 50): DecisionsStats["recent"] {
    return this.#recent.all(limit).map((row) => {
      const label = opt(row["label"], String);
      const score = opt(row["score"], Number);
      const usd = opt(row["cost_usd"], Number);
      const model = opt(row["model"], String);
      const error = opt(row["error"], String);
      return {
        at: Number(row["at"]),
        site: String(row["site"]) as JudgeSite,
        source: String(row["source"]) as JudgeSource,
        questionId: String(row["question_id"]),
        ...(label !== undefined ? { label } : {}),
        ...(score !== undefined ? { score } : {}),
        confidence: Number(row["confidence"]),
        tokens: Number(row["input_tokens"]),
        ...(usd !== undefined ? { usd } : {}),
        elapsedMs: Number(row["elapsed_ms"]),
        ...(model !== undefined ? { model } : {}),
        ...(error !== undefined ? { error } : {}),
      };
    });
  }

  stats(now: number, limit = 50): DecisionsStats {
    return { ...this.statsToday(now), recent: this.recent(limit) };
  }
}
