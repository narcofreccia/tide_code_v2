import { describe, expect, it } from "vitest";
import type { Activity, ActivityOf } from "@tide/contracts";
import type { JudgeVerdict } from "../judge.ts";
import { fakeJudge } from "../testing.ts";
import { ApprovalsSite, pathsOf } from "./approvals.ts";
import { memoryEngine, seedProject } from "./harness.testutil.ts";

async function rig(options: { enabled?: boolean; auto?: boolean; verdict?: Partial<JudgeVerdict> } = {}) {
  const engine = await memoryEngine();
  const projectId = await seedProject(engine);
  const created = (await engine.dispatch({ type: "thread.create", projectId, provider: "claude", title: "Work" })).events[0]?.event;
  if (created?.type !== "thread.created") throw new Error("thread");
  const threadId = created.thread.id;
  if (options.auto === true) await engine.dispatch({ type: "thread.update", threadId, autoAllowRoutine: true });
  const turn = (await engine.dispatch({ type: "turn.request", threadId, text: "go" })).events.find((e) => e.event.type === "turn.requested")?.event;
  if (turn?.type !== "turn.requested") throw new Error("turn");
  await engine.dispatch({ type: "turn.start", turnId: turn.turn.id, provider: "claude" });
  const script: Record<string, Partial<JudgeVerdict>> = {};
  const judge = fakeJudge(script, { enabled: options.enabled ?? true });
  const site = new ApprovalsSite({ engine, judge, grayZone: () => ({ low: 0.6, high: 0.85 }), now: () => 7_000, newId: () => "info-1", log: () => undefined });
  site.start();
  const approval = (id: string, patch: Partial<ActivityOf<"approval">> = {}): Activity => ({
    id, threadId, turnId: turn.turn.id, createdAt: 1, updatedAt: 1, kind: "approval", requestId: `req-${id}`, toolName: "Read", input: { file_path: "src/a.ts" }, title: "Read src/a.ts", status: "pending", ...patch,
  });
  if (options.verdict !== undefined) script["approval:a1"] = options.verdict;
  return { engine, site, judge, threadId, approval };
}

describe("ApprovalsSite", () => {
  it("asks one routine/consequential question per pending approval, with clipped state", async () => {
    const r = await rig();
    const diff = Array.from({ length: 80 }, (_, i) => `+line ${i}`).join("\n");
    const a = r.approval("a1", { input: { file_path: "src/a.ts", blob: "z".repeat(2000) }, diff });
    await r.engine.dispatch({ type: "activity.upsert", activity: a });
    await r.engine.dispatch({ type: "activity.upsert", activity: a }); // same id: deduped
    await r.site.drain();
    expect(r.judge.questions).toHaveLength(1);
    const q = r.judge.questions[0] as unknown as { id: string; labels: Record<string, string>; state: Record<string, unknown> };
    expect(q.id).toBe("approval:a1");
    expect(Object.keys(q.labels)).toEqual(["routine", "consequential"]);
    expect(q.state).toMatchObject({ toolName: "Read", title: "Read src/a.ts", thread: "Work", paths: ["src/a.ts"] });
    expect((q.state["input"] as string).length).toBeLessThanOrEqual(801);
    expect((q.state["diffHead"] as string).split("\n")).toHaveLength(40);
  });

  it("records the verdict on the approval but never answers it without the opt-in", async () => {
    const r = await rig({ verdict: { label: "routine", confidence: 0.95 } });
    await r.engine.dispatch({ type: "activity.upsert", activity: r.approval("a1") });
    await r.site.drain();
    const a = r.engine.getModel().activities["a1"] as ActivityOf<"approval">;
    expect(a.judge).toEqual({ site: "approvals", label: "routine", confidence: 0.95, source: "jev", at: 7_000 });
    expect(a.status).toBe("pending");
  });

  it("auto-allows a routine Jev verdict at or above high on an opted-in thread, with an info line", async () => {
    const r = await rig({ auto: true, verdict: { label: "routine", confidence: 0.93 } });
    await r.engine.dispatch({ type: "activity.upsert", activity: r.approval("a1") });
    await r.site.drain();
    const m = r.engine.getModel();
    expect((m.activities["a1"] as ActivityOf<"approval">).status).toBe("resolved");
    expect((m.activities["a1"] as ActivityOf<"approval">).decision).toBe("accept");
    expect(m.activities["info-1"]).toMatchObject({ kind: "info", text: "Auto-allowed (routine, jev 0.93)" });
  });

  it.each([
    ["below high", { label: "routine", confidence: 0.7 }],
    ["consequential", { label: "consequential", confidence: 0.99 }],
    ["fallback source", { label: "routine", confidence: 1, source: "fallback" as const }],
  ])("does not auto-allow when %s", async (_name, verdict) => {
    const r = await rig({ auto: true, verdict });
    await r.engine.dispatch({ type: "activity.upsert", activity: r.approval("a1") });
    await r.site.drain();
    expect((r.engine.getModel().activities["a1"] as ActivityOf<"approval">).status).toBe("pending");
  });

  it("does nothing when the site is disabled", async () => {
    const r = await rig({ enabled: false, auto: true, verdict: { label: "routine", confidence: 0.99 } });
    await r.engine.dispatch({ type: "activity.upsert", activity: r.approval("a1") });
    await r.site.drain();
    expect(r.judge.questions).toHaveLength(0);
    expect((r.engine.getModel().activities["a1"] as ActivityOf<"approval">).status).toBe("pending");
  });

  it("finds path-like strings in tool input", () => {
    expect(pathsOf({ command: "rm -rf build", file_path: "/etc/hosts", nested: [{ p: "../x/y.ts" }], word: "hello" })).toEqual(["/etc/hosts", "../x/y.ts"]);
  });
});
