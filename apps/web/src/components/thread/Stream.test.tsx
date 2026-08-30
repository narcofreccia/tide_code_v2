import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Stream } from "./Stream.tsx";
import {
  attachFakeStore,
  makeApproval,
  makeThread,
  makeTool,
  modelWithTimeline,
  resetUi,
} from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const thread = makeThread("t1");

describe("Stream", () => {
  it("renders a single activity row with its tool and target", () => {
    attachFakeStore(modelWithTimeline(thread, [makeTool("a1", { toolName: "Bash", input: { command: "pnpm test" }, durationMs: 2100 })]));
    render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByText("Bash")).toBeDefined();
    expect(screen.getByText("pnpm test")).toBeDefined();
    expect(screen.getByText("2.1s")).toBeDefined();
  });

  it("collapses consecutive reads into a group that expands", () => {
    attachFakeStore(
      modelWithTimeline(thread, [makeTool("a1"), makeTool("a2"), makeTool("a3"), makeTool("a4")]),
    );
    render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByText("read 4 files")).toBeDefined();
    expect(screen.queryByText("Read")).toBeNull();

    fireEvent.click(screen.getByText("read 4 files"));
    expect(screen.getAllByText("Read")).toHaveLength(4);
  });

  it("expands a row to show input and output", () => {
    attachFakeStore(
      modelWithTimeline(thread, [makeTool("a1", { toolName: "Bash", input: { command: "ls" }, output: "a.ts" })]),
    );
    render(<Stream threadId="t1" provider="claude" />);
    expect(screen.queryByText("output")).toBeNull();
    fireEvent.click(screen.getByLabelText("Bash ls"));
    expect(screen.getByText("output")).toBeDefined();
    expect(screen.getByText("a.ts")).toBeDefined();
  });

  it("marks only the last pending approval as the live prompt", () => {
    attachFakeStore(
      modelWithTimeline(thread, [
        makeApproval("a1", { status: "resolved", decision: "accept" }),
        makeApproval("a2"),
      ]),
    );
    render(<Stream threadId="t1" provider="claude" />);
    expect(screen.getByText("Allowed Edit")).toBeDefined();
    expect(screen.getAllByText("Allow")).toHaveLength(1);
  });
});
