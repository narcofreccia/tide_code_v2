import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Activity } from "@tide/contracts";
import type { TimelineItem } from "@tide/client";
import { HarnessEvents, collapsePassThrough, eventNames } from "./HarnessEvents.tsx";

afterEach(cleanup);

const info = (id: string, turnId: string, text: string, payload?: unknown): TimelineItem => ({
  kind: "activity",
  activity: { id, threadId: "t1", turnId, createdAt: 1, updatedAt: 1, kind: "info", text, ...(payload === undefined ? {} : { payload }) } as Activity,
});

describe("pass-through harness rows", () => {
  it("collapses raw frames to one anchor per turn and leaves plain info rows alone", () => {
    const { entries, groups } = collapsePassThrough([
      info("a", "u1", "claude: system/task_notification", {}),
      info("b", "u1", "claude: system/status", {}),
      info("c", "u1", "Compacted the conversation"),
      info("d", "u2", "claude: system/status", {}),
      info("e", "u1", "codex: item/x (declined, not handled by Tide)", {}),
    ]);
    expect(entries.map((e) => (e.kind === "activity" ? e.activity.id : ""))).toEqual(["a", "c", "d", "e"]);
    expect(groups.get("a")?.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("collapses harness-named info rows without a payload, e.g. Codex notifications", () => {
    const { entries, groups } = collapsePassThrough([
      info("a", "u1", "codex: mcpServer/startupStatus/updated"),
      info("b", "u1", "codex: account/updated"),
      info("c", "u1", "PONG"),
      info("d", "u1", "codex: turn/moderationMetadata"),
      info("e", "u1", "opencode: session.updated"),
    ]);
    expect(entries.map((e) => (e.kind === "activity" ? e.activity.id : ""))).toEqual(["a", "c"]);
    expect(groups.get("a")?.map((x) => x.id)).toEqual(["a", "b", "d", "e"]);
  });

  it("renders a muted count that opens to the raw rows", () => {
    const rows = collapsePassThrough([
      info("a", "u1", "claude: system/one", {}),
      info("b", "u1", "claude: system/two", {}),
    ]).groups.get("a")!;
    render(<ul><HarnessEvents activities={rows} /></ul>);
    fireEvent.click(screen.getByText("2 harness events"));
    expect(screen.getByLabelText("claude: system/two")).toBeDefined();
  });

  it("names the events inline while collapsed, three at most", () => {
    const rows = collapsePassThrough([
      info("a", "u1", "claude: system/session_resumed", { type: "system", subtype: "session_resumed" }),
      info("b", "u1", "claude: system/compact", { type: "system", subtype: "compactBoundary" }),
    ]).groups.get("a")!;
    render(<ul><HarnessEvents activities={rows} /></ul>);
    expect(screen.getByText("· session resumed, compact boundary")).toBeDefined();
    const four = ["one", "two", "three", "four"].map((n, i) => info(`x${i}`, "u9", `codex: thing/${n}`));
    expect(eventNames(collapsePassThrough(four).groups.get("x0")!)).toBe("one, two, three, …");
  });
});
