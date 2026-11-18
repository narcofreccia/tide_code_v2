import { describe, expect, it } from "vitest";
import type { TimelineItem } from "@tide/client";
import type { Activity } from "@tide/contracts";
import { splitChildren } from "./streamModel.ts";

const base = { threadId: "t1", turnId: "u1", createdAt: 1, updatedAt: 1 };
const item = (activity: Record<string, unknown>): TimelineItem => ({ kind: "activity", activity: { ...base, ...activity } as Activity });

const child = item({ id: "c", kind: "child", childKey: "agent-1", name: "Audit", status: "running" });
const tool = item({ id: "tool", kind: "tool", toolUseId: "x", toolName: "Bash", input: {}, status: "ok", parentToolUseId: "agent-1" });
const approval = item({ id: "ap", kind: "approval", requestId: "r1", toolName: "Bash", input: {}, status: "pending", parentToolUseId: "agent-1" });
const question = item({ id: "q", kind: "user-input", requestId: "r2", questions: [], status: "pending", parentToolUseId: "agent-1" });
const stray = item({ id: "s", kind: "tool", toolUseId: "y", toolName: "Read", input: {}, status: "ok", parentToolUseId: "gone" });

describe("splitChildren", () => {
  it("moves a sub-agent's tool rows under its header", () => {
    const split = splitChildren([child, tool]);
    expect(split.top).toEqual([child]);
    expect(split.nested.get("agent-1")?.map((a) => a.id)).toEqual(["tool"]);
  });

  it("keeps a sub-agent's approval and question in the main flow, where they are answered", () => {
    const split = splitChildren([child, tool, approval, question]);
    expect(split.top).toEqual([child, approval, question]);
    expect(split.nested.get("agent-1")?.map((a) => a.id)).toEqual(["tool"]);
  });

  it("leaves a row whose sub-agent is not in the timeline where it is", () => {
    expect(splitChildren([stray]).top).toEqual([stray]);
  });
});
