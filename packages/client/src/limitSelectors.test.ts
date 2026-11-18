import { describe, expect, it } from "vitest";
import { emptyReadModel, type RateLimit, type ReadModel, type Thread } from "@tide/contracts";
import { selectInbox } from "./inboxSelectors.ts";
import { limitedView, selectLimitReady, selectLimited } from "./limitSelectors.ts";

const NOW = 10_000;

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  title: id,
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

function build(threads: Thread[], limits?: ReadModel["limits"]): ReadModel {
  const model = emptyReadModel();
  for (const t of threads) {
    model.threads[t.id] = t;
    model.threadTimeline[t.id] = [];
  }
  if (limits !== undefined) model.limits = limits;
  return model;
}

const gauge = (patch: Partial<RateLimit>): RateLimit => ({ status: "ok", at: 1, ...patch });

describe("limitedView", () => {
  it("waits while the reset is ahead, is ready once it passed", () => {
    const t = thread("t", { limited: { resume: "manual", resetsAt: NOW + 3_600_000, at: 1 } });
    expect(limitedView(build([t]), t, NOW)).toEqual({ phase: "waiting", policy: "manual", resetsAt: NOW + 3_600_000, needsUser: false });
    expect(limitedView(build([t]), t, NOW + 3_600_000)?.phase).toBe("ready");
    expect(limitedView(build([t]), t, NOW + 3_600_000)?.needsUser).toBe(true);
  });

  it("is ready with the reset policy too, but does not need the user", () => {
    const t = thread("t", { limited: { resume: "reset", resetsAt: NOW - 1, at: 1 } });
    expect(limitedView(build([t]), t, NOW)).toMatchObject({ phase: "ready", policy: "reset", needsUser: false });
  });

  it("is unknown without a reset time, and ready once the window reports open again", () => {
    const t = thread("t", { limited: { resume: "manual", window: "weekly", at: 5 } });
    expect(limitedView(build([t]), t, NOW)?.phase).toBe("unknown");
    const open = build([t], { claude: { weekly: gauge({ at: 6, window: "weekly" }) } });
    expect(limitedView(open, t, NOW)?.phase).toBe("ready");
    expect(limitedView(build([thread("x")]), thread("x"), NOW)).toBeUndefined();
  });
});

describe("limit-ready threads", () => {
  const ready = thread("ready", { title: "Ready", limited: { resume: "manual", resetsAt: NOW - 10, at: 1 } });
  const waiting = thread("waiting", { limited: { resume: "manual", resetsAt: NOW + 10, at: 1 } });
  const auto = thread("auto", { limited: { resume: "reset", resetsAt: NOW - 10, at: 1 } });
  const archived = thread("arch", { archivedAt: 2, limited: { resume: "manual", resetsAt: NOW - 10, at: 1 } });

  it("selects only manual threads whose window reopened", () => {
    const model = build([ready, waiting, auto, archived]);
    expect(selectLimitReady(model, undefined, NOW).map((t) => t.id)).toEqual(["ready"]);
    expect(selectLimitReady(model, "other", NOW)).toEqual([]);
    expect(selectLimited(model).map((t) => t.id)).toEqual(["auto", "ready", "waiting"]);
  });

  it("puts a ready manual thread in the inbox as needing the user", () => {
    const model = build([ready, waiting, auto]);
    const items = selectInbox(model, undefined, NOW);
    expect(items.map((i) => [i.key, i.attention])).toEqual([["limit:ready", "limit"]]);
    expect(selectInbox(model, undefined, NOW - 100)).toEqual([]);
    // a snoozed thread waits for its snooze
    expect(selectInbox(build([{ ...ready, snoozedUntil: NOW + 5 }]), undefined, NOW)).toEqual([]);
  });
});
