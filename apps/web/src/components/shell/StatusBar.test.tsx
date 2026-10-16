import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { StatusBar } from "./StatusBar.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("StatusBar", () => {
  it("reports the thread only while the thread is what the view shows", () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1", { worktreePath: "/w/t1", branch: "tide/t1" }) } }));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(<StatusBar />);
    expect(screen.getByText(/thread:/)).toBeDefined();
    act(() => useUi.setState({ view: "mission" }));
    expect(screen.queryByText(/thread:/)).toBeNull();
    expect(screen.queryByText(/tide\/t1/)).toBeNull();
    act(() => useUi.setState({ view: "settings" }));
    expect(screen.queryByText(/thread:/)).toBeNull();
  });
});
