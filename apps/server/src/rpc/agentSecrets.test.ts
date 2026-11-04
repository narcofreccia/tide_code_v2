import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ActivityOf, DomainEvent, RpcFrame } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import type { CancelTimer } from "./agentThreads.ts";
import { registerAgentSecretHandlers } from "./agentSecrets.ts";
import { RpcRouter } from "./router.ts";

const SECRET = "ghp_very_secret_value_123";

/** Timers the test fires by hand. */
class ManualClock {
  #pending: { fn: () => void; ms: number }[] = [];
  schedule = (fn: () => void, ms: number): CancelTimer => {
    const entry = { fn, ms };
    this.#pending.push(entry);
    return () => {
      this.#pending = this.#pending.filter((e) => e !== entry);
    };
  };
  get delays(): number[] {
    return this.#pending.map((e) => e.ms);
  }
  fireAll(): void {
    const due = this.#pending.splice(0);
    for (const e of due) e.fn();
  }
}

interface Harness {
  engine: Engine;
  store: EventStore;
  clock: ManualClock;
  home: string;
  threadId: string;
  turnId: string;
  agentCall(method: string, params: unknown): Promise<RpcFrame>;
  clientCall(method: string, params: unknown): Promise<RpcFrame>;
  /** resolves with the pending secret card once it is on the model */
  card(): Promise<ActivityOf<"user-input">>;
}

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function first<T extends DomainEvent["type"]>(events: { event: DomainEvent }[], type: T): Extract<DomainEvent, { type: T }> {
  const found = events.map((r) => r.event).find((e): e is Extract<DomainEvent, { type: T }> => e.type === type);
  if (!found) throw new Error(`expected ${type}`);
  return found;
}

async function harness(): Promise<Harness> {
  const store = new EventStore(await openDatabase(":memory:"));
  const engine = new Engine({ store });
  const clock = new ManualClock();
  const home = mkdtempSync(join(tmpdir(), "tide-secrets-"));
  homes.push(home);
  const router = new RpcRouter();
  registerAgentSecretHandlers(router, { engine, tideHome: home, schedule: clock.schedule });
  const project = first((await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events, "project.created");
  const thread = first((await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events, "thread.created");
  const turn = first((await engine.dispatch({ type: "turn.request", threadId: thread.thread.id, text: "deploy it" })).events, "turn.requested");
  const call = (agentThreadId: string | undefined) => (method: string, params: unknown): Promise<RpcFrame> =>
    new Promise((resolve) => {
      let n = 0;
      const conn = router.connection(`c${n++}`, resolve, agentThreadId !== undefined ? { agentThreadId } : {});
      void conn.handleRequest("r1", method, params);
    });
  const card = (): Promise<ActivityOf<"user-input">> =>
    new Promise((resolve) => {
      const check = (): boolean => {
        const a = Object.values(engine.getModel().activities).find((x) => x.kind === "user-input" && x.status === "pending");
        if (a?.kind !== "user-input") return false;
        resolve(a);
        return true;
      };
      if (check()) return;
      const off = engine.subscribe(() => {
        if (check()) off();
      });
    });
  return { engine, store, clock, home, threadId: thread.thread.id, turnId: turn.turn.id, agentCall: call(thread.thread.id), clientCall: call(undefined), card };
}

const result = (frame: RpcFrame): unknown => (frame as { result?: unknown }).result;
const errorCode = (frame: RpcFrame): string | undefined => (frame as { error?: { code: string } }).error?.code;
const everything = (h: Harness): string => JSON.stringify(h.engine.getModel()) + JSON.stringify(h.store.readAll());

describe("agent.secret.request", () => {
  it("raises a masked card on the caller's turn and hands the provided value to the tool only", async () => {
    const h = await harness();
    const pending = h.agentCall("agent.secret.request", { name: "GITHUB_TOKEN", purpose: "push the release branch" });
    const card = await h.card();
    expect(card).toMatchObject({ kind: "user-input", secret: true, turnId: h.turnId, questions: [{ id: "GITHUB_TOKEN", text: "push the release branch" }], status: "pending" });
    expect(card.requestId).toMatch(/^secret:/);
    expect(h.clock.delays).toEqual([10 * 60_000]);

    const provided = await h.clientCall("secret.provide", { threadId: h.threadId, requestId: card.requestId, value: SECRET });
    expect(result(provided)).toEqual({ ok: true });
    expect(result(await pending)).toEqual({ decided: "provided", value: SECRET });
    await h.engine.drain();

    const resolved = h.engine.getModel().activities[card.id];
    expect(resolved).toMatchObject({ status: "resolved", answers: { decided: "provided" } });
    expect(everything(h)).not.toContain(SECRET);
    expect(h.clock.delays).toEqual([]);
    // consumed once: a second provide has nothing to answer
    expect(errorCode(await h.clientCall("secret.provide", { threadId: h.threadId, requestId: card.requestId, value: SECRET }))).toBe("not-found");
  });

  it("resolves declined when the user declines", async () => {
    const h = await harness();
    const pending = h.agentCall("agent.secret.request", { name: "API_KEY", purpose: "call the API" });
    const card = await h.card();
    await h.engine.dispatch({ type: "user-input.respond", threadId: h.threadId, requestId: card.requestId, answers: { decided: "declined" } });
    expect(result(await pending)).toEqual({ decided: "declined" });
  });

  it("declines and closes the card on timeout", async () => {
    const h = await harness();
    const pending = h.agentCall("agent.secret.request", { name: "API_KEY", purpose: "call the API", timeoutMs: 5000 });
    const card = await h.card();
    expect(h.clock.delays).toEqual([5000]);
    h.clock.fireAll();
    expect(result(await pending)).toEqual({ decided: "declined" });
    await h.engine.drain();
    expect(h.engine.getModel().activities[card.id]).toMatchObject({ status: "resolved", answers: { decided: "declined" } });
  });

  it("resolves declined when the turn settles first", async () => {
    const h = await harness();
    const pending = h.agentCall("agent.secret.request", { name: "API_KEY", purpose: "call the API" });
    const card = await h.card();
    await h.engine.dispatch({ type: "turn.settle", turnId: h.turnId, status: "interrupted" });
    expect(result(await pending)).toEqual({ decided: "declined" });
    expect(h.engine.getModel().activities[card.id]).toMatchObject({ status: "resolved" });
    expect(h.clock.delays).toEqual([]);
  });

  it("kind file writes a 0600 file under a 0700 dir and returns only the path", async () => {
    const h = await harness();
    const pending = h.agentCall("agent.secret.request", { name: "DEPLOY_KEY", purpose: "ssh to prod", kind: "file" });
    const card = await h.card();
    await h.clientCall("secret.provide", { threadId: h.threadId, requestId: card.requestId, value: SECRET });
    const out = result(await pending) as { decided: string; value?: string; path?: string };
    const path = join(h.home, "secrets", h.threadId, "DEPLOY_KEY");
    expect(out).toEqual({ decided: "provided", path });
    expect(readFileSync(path, "utf8")).toBe(SECRET);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(h.home, "secrets", h.threadId)).mode & 0o777).toBe(0o700);
    expect(everything(h)).not.toContain(SECRET);
  });

  it("refuses without an active turn", async () => {
    const h = await harness();
    await h.engine.dispatch({ type: "turn.settle", turnId: h.turnId, status: "completed" });
    expect(errorCode(await h.agentCall("agent.secret.request", { name: "API_KEY", purpose: "x" }))).toBe("conflict");
  });
});

describe("secret.provide", () => {
  it("is not-found for an unknown or non-secret request", async () => {
    const h = await harness();
    expect(errorCode(await h.clientCall("secret.provide", { threadId: h.threadId, requestId: "secret:nope", value: "x" }))).toBe("not-found");
    const now = Date.now();
    await h.engine.dispatch({
      type: "activity.upsert",
      activity: { id: "act-q", threadId: h.threadId, turnId: h.turnId, kind: "user-input", requestId: "q1", questions: [{ id: "a", text: "Which?" }], status: "pending", createdAt: now, updatedAt: now },
    });
    expect(errorCode(await h.clientCall("secret.provide", { threadId: h.threadId, requestId: "q1", value: "x" }))).toBe("not-found");
  });

  it("is client-only and agent.secret.request agent-only", async () => {
    const h = await harness();
    expect(errorCode(await h.agentCall("secret.provide", { threadId: h.threadId, requestId: "secret:x", value: "x" }))).toBe("forbidden");
    expect(errorCode(await h.clientCall("agent.secret.request", { name: "A", purpose: "x" }))).toBe("forbidden");
  });
});
