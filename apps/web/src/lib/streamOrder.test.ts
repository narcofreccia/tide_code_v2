import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@tide/client";
import type { Activity, Message, Turn } from "@tide/contracts";
import { orderByTurn, queuedTurnIds } from "./streamOrder.ts";

const msg = (id: string, turnId: string, role: "user" | "assistant" = "assistant"): TimelineItem => ({
  kind: "message",
  message: { id, threadId: "t1", turnId, role, text: id, createdAt: 0 } as unknown as Message,
});
const act = (id: string, turnId: string): TimelineItem => ({
  kind: "activity",
  activity: { id, threadId: "t1", turnId, kind: "info", text: id, createdAt: 0, updatedAt: 0 } as unknown as Activity,
});
const turn = (id: string, requestedAt: number, settledAt?: number): Turn =>
  ({ id, threadId: "t1", status: "completed", requestedAt, ...(settledAt === undefined ? {} : { settledAt }) }) as Turn;

const ids = (entries: TimelineItem[]): string[] =>
  entries.map((e) => (e.kind === "message" ? e.message.id : e.kind === "activity" ? e.activity.id : e.plan.id));

describe("orderByTurn", () => {
  it("moves a message queued mid-turn after that turn's later activities", () => {
    // u2 was appended when the user queued it, while turn a was still working
    const entries = [msg("u1", "a", "user"), act("bash", "a"), msg("u2", "b", "user"), act("sub", "a"), msg("ok", "a"), msg("queued", "b")];
    const turns = [turn("a", 1, 10), turn("b", 5, 12)];
    expect(ids(orderByTurn(entries, turns))).toEqual(["u1", "bash", "sub", "ok", "u2", "queued"]);
  });

  it("keeps entries of an unknown turn after the turn they followed", () => {
    const entries = [msg("u1", "a", "user"), act("x", "ghost"), msg("u2", "b", "user")];
    expect(ids(orderByTurn(entries, [turn("a", 1), turn("b", 2)]))).toEqual(["u1", "x", "u2"]);
  });
});

describe("queuedTurnIds", () => {
  it("flags a turn requested before the previous one settled", () => {
    expect([...queuedTurnIds([turn("a", 1, 10), turn("b", 5, 12), turn("c", 20, 30)])]).toEqual(["b"]);
  });
});
