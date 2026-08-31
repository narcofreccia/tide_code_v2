import { describe, expect, it } from "vitest";
import { emptyReadModel, type ExpertsSession, type ReadModel, type Thread } from "@tide/contracts";
import { selectDelegates, selectExpertsBoard, selectExpertsSessions } from "./selectors.ts";

const thread = (id: string, patch: Partial<Thread> = {}): Thread => ({
  id,
  projectId: "p1",
  title: `Thread ${id}`,
  provider: "claude",
  mode: "approval-required",
  interaction: "default",
  status: "idle",
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const session = (id: string, patch: Partial<ExpertsSession> = {}): ExpertsSession => ({
  id,
  projectId: "p1",
  topic: `Topic ${id}`,
  phase: "exploring",
  experts: [{ key: "arch", name: "Architect", role: "architecture", provider: "claude", status: "idle" }],
  lead: { provider: "claude" },
  findingIds: [],
  messageIds: [],
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});

const modelWith = (patch: Partial<ReadModel>): ReadModel => ({ ...emptyReadModel(), ...patch });

describe("selectExpertsSessions", () => {
  it("drops archived sessions and sorts newest first", () => {
    const model = modelWith({
      expertsSessions: {
        a: session("a", { createdAt: 10 }),
        b: session("b", { createdAt: 30 }),
        c: session("c", { createdAt: 20, phase: "archived" }),
      },
    });
    expect(selectExpertsSessions(model).map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("filters by project", () => {
    const model = modelWith({
      expertsSessions: { a: session("a"), b: session("b", { projectId: "p2" }) },
    });
    expect(selectExpertsSessions(model, "p2").map((s) => s.id)).toEqual(["b"]);
  });
});

describe("selectExpertsBoard", () => {
  it("resolves findings, messages and the expert/lead threads", () => {
    const model = modelWith({
      threads: {
        te: thread("te", { role: "expert", expertsSessionId: "s1" }),
        tl: thread("tl", { role: "lead", expertsSessionId: "s1" }),
      },
      expertsSessions: {
        s1: session("s1", {
          experts: [
            { key: "arch", name: "Architect", role: "architecture", provider: "claude", status: "working", threadId: "te" },
            { key: "sec", name: "Security", role: "security", provider: "codex", status: "pending" },
          ],
          lead: { provider: "claude", threadId: "tl" },
          findingIds: ["f1", "missing"],
          messageIds: ["m1"],
        }),
      },
      expertsFindings: {
        f1: { id: "f1", sessionId: "s1", author: "arch", text: "seams matter", createdAt: 2 },
      },
      expertsMessages: {
        m1: { id: "m1", sessionId: "s1", from: "user", to: "all", text: "hi", createdAt: 3 },
      },
    });
    const board = selectExpertsBoard(model, "s1");
    expect(board?.findings.map((f) => f.id)).toEqual(["f1"]);
    expect(board?.messages.map((m) => m.id)).toEqual(["m1"]);
    expect(board?.expertThreads.arch?.id).toBe("te");
    expect(board?.expertThreads.sec).toBeUndefined();
    expect(board?.leadThread?.id).toBe("tl");
  });

  it("returns undefined for an unknown session", () => {
    expect(selectExpertsBoard(emptyReadModel(), "nope")).toBeUndefined();
  });
});

describe("selectDelegates", () => {
  it("returns non-archived children by delegatedBy, oldest first", () => {
    const model = modelWith({
      threads: {
        parent: thread("parent"),
        d2: thread("d2", { delegatedBy: "parent", createdAt: 5, role: "delegate" }),
        d1: thread("d1", { delegatedBy: "parent", createdAt: 3, role: "delegate" }),
        gone: thread("gone", { delegatedBy: "parent", createdAt: 4, archivedAt: 9 }),
        other: thread("other", { delegatedBy: "elsewhere" }),
      },
    });
    expect(selectDelegates(model, "parent").map((t) => t.id)).toEqual(["d1", "d2"]);
  });
});
