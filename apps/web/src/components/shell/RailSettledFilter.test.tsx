import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { RailGroups } from "./RailGroups.tsx";
import { RAIL_GROUPS_KEY, SETTLED_MERGED_KEY } from "./railGroupState.ts";

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(RAIL_GROUPS_KEY, JSON.stringify({ settled: false }));
});
afterEach(() => {
  cleanup();
  resetUi();
  window.localStorage.clear();
});

function mount() {
  attachFakeStore(
    modelWith({
      projects: { p1: { id: "p1", title: "P", rootPath: "/p", createdAt: 1, updatedAt: 1 } },
      threads: {
        m: makeThread("m", { title: "Merged one", settledAt: 5, settleReason: "merged-back" }),
        u: makeThread("u", { title: "Manual one", settledAt: 4, settleReason: "user" }),
      },
    }),
  );
  return render(<RailGroups projectIds={["p1"]} showProject={false} />);
}

describe("settled merged-only filter", () => {
  it("shows only merged settles, counts filtered/total, and survives a re-mount", () => {
    const first = mount();
    expect(screen.getByText("Manual one")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "merged only" }));
    expect(screen.queryByText("Manual one")).toBeNull();
    expect(screen.getByText("Merged one")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
    expect(window.localStorage.getItem(SETTLED_MERGED_KEY)).toBe("1");
    first.unmount();
    mount();
    expect(screen.queryByText("Manual one")).toBeNull();
    expect(screen.getByRole("button", { name: "merged only" }).getAttribute("aria-pressed")).toBe("true");
  });
});
