import { describe, expect, it } from "vitest";
import type { JudgeVerdict } from "../judge.ts";
import { fakeJudge } from "../testing.ts";
import { ExpertsSite } from "./experts.ts";
import { memoryEngine, seedProject } from "./harness.testutil.ts";

async function rig(options: { enabled?: boolean; auto?: boolean; verdict?: Partial<JudgeVerdict> } = {}) {
  const engine = await memoryEngine();
  const projectId = await seedProject(engine);
  const created = (
    await engine.dispatch({
      type: "experts.create",
      projectId,
      topic: "caching",
      experts: [
        { key: "perf", name: "Pat", role: "performance", provider: "claude" },
        { key: "api", name: "Ana", role: "API", provider: "claude" },
      ],
      lead: { provider: "claude" },
    })
  ).events[0]?.event;
  if (created?.type !== "experts.created") throw new Error("session");
  const sessionId = created.session.id;
  await engine.dispatch({ type: "experts.start", sessionId });
  const script: Record<string, Partial<JudgeVerdict>> = {};
  const judge = fakeJudge(script, { enabled: options.enabled ?? true });
  const site = new ExpertsSite({ engine, judge, grayZone: () => ({ low: 0.6, high: 0.85 }), autoAdvance: () => options.auto === true, now: () => 9_000, log: () => undefined });
  site.start();
  const finding = (author: string, text: string) => engine.dispatch({ type: "experts.finding.post", sessionId, author, text });
  const status = (key: string, s: "working" | "idle") => engine.dispatch({ type: "experts.expert.status", sessionId, key, status: s });
  const session = () => engine.getModel().expertsSessions[sessionId];
  return { engine, site, judge, script, sessionId, finding, status, session, options };
}

describe("ExpertsSite", () => {
  it("asks once all experts are idle with new findings, and records the verdict", async () => {
    const r = await rig();
    await r.status("perf", "working");
    await r.status("api", "working");
    for (const t of ["a", "b", "c"]) await r.finding("perf", `perf ${t} ${"x".repeat(900)}`);
    await r.finding("api", "api says hi");
    await r.status("perf", "idle");
    await r.site.drain();
    expect(r.judge.questions).toHaveLength(0); // api still working
    r.script[`experts:${r.sessionId}:4`] = { label: "true", score: 0.9, confidence: 0.9 };
    await r.status("api", "idle");
    await r.site.drain();
    expect(r.judge.questions).toHaveLength(1);
    const q = r.judge.questions[0] as unknown as { id: string; kind: string; state: { topic: string; phase: string; findings: Record<string, string[]> } };
    expect(q).toMatchObject({ id: `experts:${r.sessionId}:4`, kind: "yes-no" });
    expect(q.state.topic).toBe("caching");
    expect(q.state.findings["perf"]).toHaveLength(2);
    expect(q.state.findings["perf"]?.[0]?.length).toBe(501);
    expect(r.session()?.judge).toMatchObject({ site: "experts", label: "true", confidence: 0.9 });
    expect(r.session()?.phase).toBe("exploring"); // no opt-in: never moves
    // same findings count: not asked again
    await r.status("api", "working");
    await r.status("api", "idle");
    await r.site.drain();
    expect(r.judge.questions).toHaveLength(1);
  });

  it("advances one phase with the opt-in on a confident Jev yes, once per findings count", async () => {
    const r = await rig({ auto: true });
    await r.finding("perf", "one");
    r.script[`experts:${r.sessionId}:1`] = { label: "true", score: 0.95, confidence: 0.95 };
    await r.status("perf", "idle");
    await r.status("api", "idle");
    await r.site.drain();
    expect(r.session()?.phase).toBe("discussing");
    await r.status("perf", "working");
    await r.status("perf", "idle");
    await r.site.drain();
    expect(r.judge.questions).toHaveLength(1);
    expect(r.session()?.phase).toBe("discussing");
  });

  it("does not advance below high, from a fallback verdict, or without findings", async () => {
    const low = await rig({ auto: true });
    await low.finding("perf", "one");
    low.script[`experts:${low.sessionId}:1`] = { label: "true", score: 0.7, confidence: 0.9 };
    await low.status("perf", "idle");
    await low.status("api", "idle");
    await low.site.drain();
    expect(low.session()?.phase).toBe("exploring");
    const fb = await rig({ auto: true });
    await fb.finding("perf", "one");
    fb.script[`experts:${fb.sessionId}:1`] = { label: "true", score: 1, confidence: 1, source: "fallback" };
    await fb.status("perf", "idle");
    await fb.status("api", "idle");
    await fb.site.drain();
    expect(fb.session()?.phase).toBe("exploring");
    const none = await rig({ auto: true });
    await none.status("perf", "idle");
    await none.status("api", "idle");
    await none.site.drain();
    expect(none.judge.questions).toHaveLength(0);
  });

  it("does nothing when the site is disabled", async () => {
    const r = await rig({ enabled: false });
    await r.finding("perf", "one");
    await r.status("perf", "idle");
    await r.status("api", "idle");
    await r.site.drain();
    expect(r.judge.questions).toHaveLength(0);
  });
});
