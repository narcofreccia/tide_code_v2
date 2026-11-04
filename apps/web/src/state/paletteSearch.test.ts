import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchHit } from "@tide/contracts";

const searchServer = vi.fn<(q: string, p: string | null) => Promise<SearchHit[]>>();
vi.mock("./railSearch.ts", () => ({ SEARCH_DEBOUNCE_MS: 250, searchServer: (q: string, p: string | null) => searchServer(q, p) }));

const { setPaletteQuery, usePaletteSearch } = await import("./paletteSearch.ts");

const mk = (field: "title" | "message", id: string): SearchHit => ({ threadId: id, projectId: "p", title: id, snippet: id, field, at: 1 });

beforeEach(() => {
  vi.useFakeTimers();
  searchServer.mockReset();
  setPaletteQuery("");
});
afterEach(() => vi.useRealTimers());

describe("paletteSearch", () => {
  it("does not search under 3 characters", async () => {
    setPaletteQuery("ab");
    await vi.advanceTimersByTimeAsync(500);
    expect(searchServer).not.toHaveBeenCalled();
  });

  it("debounces to one call and keeps only message hits", async () => {
    searchServer.mockResolvedValue([mk("title", "a"), mk("message", "b")]);
    setPaletteQuery("coo");
    setPaletteQuery("cook");
    await vi.advanceTimersByTimeAsync(300);
    expect(searchServer).toHaveBeenCalledTimes(1);
    expect(searchServer).toHaveBeenCalledWith("cook", null);
    expect(usePaletteSearch.getState().hits.map((h) => h.threadId)).toEqual(["b"]);
  });

  it("ignores a stale reply and clears when the query shrinks", async () => {
    let resolve!: (h: SearchHit[]) => void;
    searchServer.mockReturnValue(new Promise((r) => (resolve = r)));
    setPaletteQuery("cook");
    await vi.advanceTimersByTimeAsync(300);
    setPaletteQuery("co");
    resolve([mk("message", "late")]);
    await vi.advanceTimersByTimeAsync(0);
    expect(usePaletteSearch.getState().hits).toEqual([]);
  });
});
