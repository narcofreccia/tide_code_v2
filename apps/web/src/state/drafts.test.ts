import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAFTS_STORAGE_KEY, applyStash, clearDraft, flushDrafts, getDraft, hydrateDrafts, removeStash, resetDrafts,
  setDraft, stashDraft, useDrafts,
} from "./drafts.ts";

const img = { id: "i1", mediaType: "image/png", data: "AAAA", bytes: 4 };

beforeEach(() => {
  window.localStorage.clear();
  resetDrafts();
});
afterEach(() => vi.useRealTimers());

describe("drafts store", () => {
  it("debounces the localStorage write by 300ms", () => {
    vi.useFakeTimers();
    setDraft("t1", { text: "hello" });
    expect(window.localStorage.getItem(DRAFTS_STORAGE_KEY)).toBeNull();
    vi.advanceTimersByTime(300);
    expect(JSON.parse(window.localStorage.getItem(DRAFTS_STORAGE_KEY)!).drafts.t1.text).toBe("hello");
  });

  it("hydrates text from storage and drops emptied drafts", async () => {
    setDraft("t1", { text: "kept" });
    setDraft("t2", { text: "x" });
    flushDrafts();
    resetDrafts();
    await hydrateDrafts();
    expect(getDraft("t1")?.text).toBe("kept");
    setDraft("t2", { text: "  " });
    expect(getDraft("t2")).toBeUndefined();
  });

  it("clears a draft", () => {
    setDraft("t1", { text: "a" });
    clearDraft("t1");
    expect(getDraft("t1")).toBeUndefined();
  });

  it("stash and apply round trip, merging into the target draft", () => {
    setDraft("t1", { text: "half written", images: [img] });
    const id = stashDraft("t1");
    expect(id).toBeDefined();
    expect(getDraft("t1")).toBeUndefined();
    expect(useDrafts.getState().stash).toHaveLength(1);
    setDraft("t2", { text: "existing" });
    expect(applyStash("t2")).toBe(true);
    expect(getDraft("t2")?.text).toBe("existing\n\nhalf written");
    expect(getDraft("t2")?.images).toEqual([img]);
    expect(useDrafts.getState().stash).toHaveLength(0);
    expect(applyStash("t2")).toBe(false);
  });

  it("applies the latest stash by default and removes by id", () => {
    setDraft("a", { text: "one" });
    stashDraft("a");
    setDraft("a", { text: "two" });
    const second = stashDraft("a")!;
    expect(useDrafts.getState().stash.map((d) => d.text)).toEqual(["one", "two"]);
    applyStash("b");
    expect(getDraft("b")?.text).toBe("two");
    setDraft("a", { text: "three" });
    const third = stashDraft("a")!;
    removeStash(third);
    expect(useDrafts.getState().stash.map((d) => d.text)).toEqual(["one"]);
    expect(second).not.toBe(third);
  });
});

describe("R11 file attachments in drafts", () => {
  it("persists file metadata (not bytes) and counts a files-only draft as non-empty", async () => {
    const file = { id: "file-1", name: "spec.pdf", mediaType: "application/pdf", bytes: 3 };
    setDraft("t1", { files: [file] });
    expect(getDraft("t1")?.files).toEqual([file]);
    flushDrafts();
    resetDrafts();
    await hydrateDrafts();
    expect(getDraft("t1")?.files).toEqual([file]);
    setDraft("t1", { files: [] });
    expect(getDraft("t1")).toBeUndefined();
  });
});
