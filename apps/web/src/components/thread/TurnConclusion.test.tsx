import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { Activity } from "@tide/contracts";
import { TurnConclusion, turnConclusion } from "./TurnConclusion.tsx";

afterEach(cleanup);

const base = { threadId: "t1", turnId: "u1", createdAt: 1, updatedAt: 1 };
const tool = (id: string, extra: Partial<Activity> = {}): Activity =>
  ({ ...base, id, kind: "tool", toolUseId: id, toolName: "Read", input: {}, status: "ok", ...extra }) as Activity;
const child = (key: string, status: "running" | "done" | "error"): Activity =>
  ({ ...base, id: `c-${key}`, kind: "child", childKey: key, name: key, status }) as Activity;

describe("turnConclusion", () => {
  it("counts the main agent's tool calls and settled sub-agents", () => {
    const text = turnConclusion([
      tool("a"),
      tool("b"),
      tool("task1", { toolName: "Task" } as Partial<Activity>),
      child("task1", "done"),
      tool("inner", { parentToolUseId: "task1" } as Partial<Activity>),
      child("task2", "error"),
    ]);
    expect(text).toBe("ended · 2 tool calls · 2 sub-agents finished (1 failed)");
  });

  it("states sub-agents that never reported back instead of calling them finished", () => {
    expect(turnConclusion([tool("s", { toolName: "SendMessage" } as Partial<Activity>), child("x", "running"), child("y", "running")])).toBe(
      "ended · 1 tool call · 2 sub-agents with no result yet",
    );
    expect(turnConclusion([])).toBe("ended");
  });

  it("renders as a list item", () => {
    render(
      <ol>
        <TurnConclusion activities={[tool("a")]} />
      </ol>,
    );
    expect(screen.getByTestId("turn-conclusion").textContent).toBe("ended · 1 tool call");
  });
});
