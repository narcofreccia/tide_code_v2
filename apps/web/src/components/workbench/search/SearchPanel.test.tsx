import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { mockRpc, resetUi } from "../../../testHarness.ts";
import { useWorkbench, threadTabs } from "../../../state/workbench.ts";
import { SearchPanel } from "./SearchPanel.tsx";

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetUi();
});

const MATCHES = [
  { path: "src/a.ts", line: 3, column: 5, text: "  const needle = 1" },
  { path: "src/a.ts", line: 9, column: 2, text: " needle again" },
  { path: "src/b.ts", line: 1, column: 1, text: "needle" },
];

async function search(query = "needle") {
  const rpc = mockRpc({ "fs.search": () => ({ matches: MATCHES, truncated: false }) });
  render(<SearchPanel threadId="t1" />);
  fireEvent.change(screen.getByLabelText("Search"), { target: { value: query } });
  await act(async () => {
    vi.advanceTimersByTime(300);
  });
  return rpc;
}

describe("SearchPanel", () => {
  it("debounces the query into one fs.search", async () => {
    const rpc = mockRpc({ "fs.search": () => ({ matches: [], truncated: false }) });
    render(<SearchPanel threadId="t1" />);
    const input = screen.getByLabelText("Search");
    fireEvent.change(input, { target: { value: "n" } });
    fireEvent.change(input, { target: { value: "ne" } });
    fireEvent.change(input, { target: { value: "nee" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("fs.search", { threadId: "t1", query: "nee", limit: 500 });
  });

  it("groups results by file", async () => {
    await search();
    expect(screen.getByText("src/a.ts")).toBeTruthy();
    expect(screen.getByText("src/b.ts")).toBeTruthy();
    expect(screen.getAllByText("2")).toHaveLength(1);
  });

  it("opens a file tab at the match position", async () => {
    await search();
    fireEvent.click(screen.getByText("needle again"));
    expect(threadTabs("t1")).toContainEqual({ kind: "file", path: "src/a.ts" });
    expect(useWorkbench.getState().reveal["t1:src/a.ts"]).toMatchObject({ line: 9, column: 2 });
  });

  it("passes the regex, case and glob toggles", async () => {
    const rpc = mockRpc({ "fs.search": () => ({ matches: [], truncated: false }) });
    render(<SearchPanel threadId="t1" />);
    fireEvent.click(screen.getByLabelText("Regular expression"));
    fireEvent.click(screen.getByLabelText("Match case"));
    fireEvent.change(screen.getByLabelText("Files to include"), { target: { value: "src/**/*.ts" } });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "ne+dle" } });
    await act(async () => {
      vi.advanceTimersByTime(300);
    });
    expect(rpc).toHaveBeenLastCalledWith("fs.search", {
      threadId: "t1",
      query: "ne+dle",
      limit: 500,
      regex: true,
      caseSensitive: true,
      glob: "src/**/*.ts",
    });
  });
});
