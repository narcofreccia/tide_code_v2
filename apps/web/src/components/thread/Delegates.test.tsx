import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThreadHeader } from "./ThreadHeader.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const model = modelWith({
  threads: {
    parent: makeThread("parent", { title: "Refactor router" }),
    d1: makeThread("d1", { title: "Bench the writer", role: "delegate", delegatedBy: "parent", status: "running" }),
    d2: makeThread("d2", { title: "Audit locks", role: "delegate", delegatedBy: "parent" }),
  },
});

describe("delegates in the thread header", () => {
  it("lists the delegated threads and jumps into one", () => {
    attachFakeStore(model);
    mockRpc({ "thread.terminalCommand": () => ({}) });
    render(<ThreadHeader thread={model.threads.parent!} />);

    fireEvent.click(screen.getByText("↳ 2 delegated"));
    expect(screen.getByText("Audit locks")).toBeDefined();
    fireEvent.click(screen.getByText("Bench the writer"));
    expect(useUi.getState().selectedThreadId).toBe("d1");
  });

  it("shows where a delegate came from and jumps back", () => {
    attachFakeStore(model);
    mockRpc({ "thread.terminalCommand": () => ({}) });
    render(<ThreadHeader thread={model.threads.d1!} />);

    fireEvent.click(screen.getByText("delegated by Refactor router"));
    expect(useUi.getState().selectedThreadId).toBe("parent");
    expect(screen.queryByText(/delegated$/)).toBeNull();
  });
});
