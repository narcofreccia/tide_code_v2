import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { Rail } from "./Rail.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { SEARCH_DEBOUNCE_MS, resetRailSearch, useRailSearch } from "../../state/railSearch.ts";
import { useUi } from "../../state/ui.ts";

/** the rail also asks for project icons on mount; only the search calls matter here */
const searches = (rpc: ReturnType<typeof mockRpc>) => rpc.mock.calls.filter((c) => c[0] === "threads.search");

afterEach(() => {
  cleanup();
  resetRailSearch();
  resetUi();
  vi.useRealTimers();
});

const project = (id: string, title: string) => ({ id, title, rootPath: `/src/${id}`, createdAt: 1, updatedAt: 1 });

function mount() {
  attachFakeStore(
    modelWith({
      projects: { p1: project("p1", "Tide"), p2: project("p2", "Atlas") },
      threads: {
        t1: makeThread("t1", { projectId: "p1", title: "Router refactor", updatedAt: 3 }),
        t2: makeThread("t2", { projectId: "p1", title: "Cache layer", updatedAt: 2 }),
        t3: makeThread("t3", { projectId: "p2", title: "Billing", updatedAt: 1 }),
      },
    }),
  );
  render(<Rail />);
  return screen.getByRole("searchbox", { name: "Search threads" });
}

describe("rail search", () => {
  it("filters locally at once, then appends server hits not already listed, each with its snippet", async () => {
    vi.useFakeTimers();
    const rpc = mockRpc({
      "threads.search": (() => ({
        hits: [
          { threadId: "t1", projectId: "p1", title: "Router refactor", snippet: "router", field: "title", at: 3 },
          { threadId: "t2", projectId: "p1", title: "Cache layer", snippet: "the router cache misses", field: "message", at: 2 },
          { threadId: "gone", projectId: "p1", title: "Unknown", snippet: "router", field: "message", at: 1 },
        ],
      })) as never,
    });
    const input = mount();
    fireEvent.change(input, { target: { value: "router" } });
    // local match, before the debounce fires
    const results = () => within(screen.getByRole("list", { name: "Results" }));
    expect(results().getAllByRole("listitem")).toHaveLength(1);
    expect(screen.queryByRole("region", { name: "Inbox" })).toBeNull();
    expect(searches(rpc)).toHaveLength(0);

    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(rpc).toHaveBeenCalledWith("threads.search", { q: "router" });
    const rows = results().getAllByRole("listitem");
    expect(rows.map((r) => r.querySelector("[data-rail-thread]")?.getAttribute("data-rail-thread"))).toEqual(["t1", "t2"]);
    expect(within(rows[1] as HTMLElement).getByText("the router cache misses")).toBeDefined();
    expect(within(rows[1] as HTMLElement).getByRole("img", { name: "message match" })).toBeDefined();
    expect(screen.getByText("Results").nextSibling?.textContent).toBe("2");
  });

  it("matches project and harness names; one character stays local", () => {
    const rpc = mockRpc({});
    const input = mount();
    fireEvent.change(input, { target: { value: "atlas" } });
    expect(within(screen.getByRole("list", { name: "Results" })).getByText("Billing")).toBeDefined();
    fireEvent.change(input, { target: { value: "b" } });
    expect(searches(rpc)).toHaveLength(0);
  });

  it("scopes the server search to the filtered project", async () => {
    vi.useFakeTimers();
    const rpc = mockRpc({ "threads.search": (() => ({ hits: [] })) as never });
    useUi.setState({ selectedProjectId: "p2" });
    const input = mount();
    fireEvent.change(input, { target: { value: "zz" } });
    await act(async () => {
      vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
    });
    expect(rpc).toHaveBeenCalledWith("threads.search", { q: "zz", projectId: "p2" });
    expect(screen.getByText("Nothing matches")).toBeDefined();
  });

  it("Esc in the field clears the query and brings the groups back", () => {
    mockRpc({ "threads.search": (() => ({ hits: [] })) as never });
    const input = mount();
    fireEvent.change(input, { target: { value: "cache" } });
    expect(screen.getByRole("list", { name: "Results" })).toBeDefined();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(useRailSearch.getState().query).toBe("");
    expect(screen.getByRole("region", { name: "Inbox" })).toBeDefined();
  });

  it("/ focuses the field when focus is not in a text field", () => {
    const input = mount();
    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(input);
  });
});
