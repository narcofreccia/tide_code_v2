import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { PrsView } from "./PrsView.tsx";
import { resetPrs } from "./prData.ts";
import { attachFakeStore, chooseOption, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { detail, item, makePr, mockRoutedRpc, resetEnvironments, twoEnvironments } from "./testFixtures.ts";

afterEach(() => {
  cleanup();
  resetUi();
  resetPrs();
  resetEnvironments();
});

const PROJECTS = {
  p1: { id: "p1", title: "App", rootPath: "/src/app", createdAt: 1, updatedAt: 1 },
  p2: { id: "p2", title: "Docs", rootPath: "/src/docs", createdAt: 1, updatedAt: 1 },
};

function rowTitles(): string[] {
  const list = screen.getByRole("region", { name: "Pull requests" });
  return within(list)
    .getAllByRole("button", { name: /^PR #/ })
    .map((b) => b.getAttribute("aria-label") ?? "");
}

describe("PrsView", () => {
  it("lists PRs by readiness, filters by project, scope and author, and sorts by update", async () => {
    attachFakeStore(modelWith({ projects: PROJECTS, threads: { t1: makeThread("t1", { title: "Fix login" }) } }));
    const rpc = mockRpc({
      "pr.list": (params: { state?: string }) => ({
        fetchedAt: 5,
        viewer: "alice",
        items:
          params.state === "all"
            ? [item(9, { state: "merged", title: "Old" })]
            : [
                item(1, { title: "Failing", checks: "failure", updatedAt: 900 }),
                item(2, { title: "Approved", reviewDecision: "approved", checks: "success", updatedAt: 100 }, { threadId: "t1" }),
                item(3, { title: "Docs fix", author: "carol", updatedAt: 950 }, { projectId: "p2" }),
              ],
      }),
    });
    render(<PrsView />);
    await screen.findByText("Approved");
    expect(rpc).toHaveBeenCalledWith("pr.list", { state: "open" });
    expect(rowTitles()).toEqual(["PR #2 Approved", "PR #3 Docs fix", "PR #1 Failing"]);

    // readiness pill, checks and review on the row
    expect(screen.getAllByText("ready")).toHaveLength(2);
    expect(screen.getByText("checks failing")).toBeDefined();
    expect(screen.getByText("✘ checks")).toBeDefined();
    expect(screen.getByText("approved")).toBeDefined();

    chooseOption("Sort", "Updated");
    expect(rowTitles()).toEqual(["PR #3 Docs fix", "PR #1 Failing", "PR #2 Approved"]);

    fireEvent.click(screen.getByRole("button", { name: "Docs" }));
    expect(useUi.getState().prsProjectId).toBe("p2");
    expect(rowTitles()).toEqual(["PR #3 Docs fix"]);
    fireEvent.click(screen.getByRole("button", { name: "All projects" }));

    fireEvent.click(screen.getByRole("button", { name: "Mine" }));
    expect(rowTitles()).toEqual(["PR #1 Failing", "PR #2 Approved"]);
    fireEvent.click(screen.getByRole("button", { name: "Mine" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "All" }));
    });
    expect(rpc).toHaveBeenCalledWith("pr.list", { state: "all" });
    await screen.findByText("Old");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    });
    expect(rpc).toHaveBeenLastCalledWith("pr.list", { state: "all", refresh: true });
  });

  it("the thread tag opens the thread", async () => {
    attachFakeStore(modelWith({ projects: PROJECTS, threads: { t1: makeThread("t1", { title: "Fix login" }) } }));
    mockRpc({ "pr.list": () => ({ fetchedAt: 5, items: [item(2, {}, { threadId: "t1" })] }) });
    render(<PrsView />);
    fireEvent.click(await screen.findByRole("button", { name: /Fix login/ }));
    expect(useUi.getState().view).toBe("thread");
    expect(useUi.getState().selectedThreadId).toBe("t1");
  });

  it("asks every connected environment and tags rows with theirs", async () => {
    twoEnvironments();
    attachFakeStore(modelWith({ projects: PROJECTS }));
    const rpc = mockRoutedRpc({
      "pr.list": (_p, opts) => ({
        fetchedAt: 5,
        items: [item(opts?.envId === "e1" ? 1 : 2, { title: `on ${opts?.envId ?? "?"}` })],
      }),
    });
    render(<PrsView />);
    await screen.findByText("on e2");
    expect(rpc).toHaveBeenCalledWith("pr.list", { state: "open" }, { envId: "e1" });
    expect(rpc).toHaveBeenCalledWith("pr.list", { state: "open" }, { envId: "e2" });
    expect(screen.getByText("Laptop")).toBeDefined();
    expect(screen.getByText("Build box")).toBeDefined();
  });

  it("opens the detail pane with the description and check runs", async () => {
    attachFakeStore(modelWith({ projects: PROJECTS }));
    const pr = makePr(4, { title: "Add cache", checkRuns: [{ name: "lint", status: "failure", url: "https://ci/lint" }] });
    mockRpc({
      "pr.list": () => ({ fetchedAt: 5, items: [{ projectId: "p1", pr }] }),
      "pr.detail": () => detail(pr, { body: "Adds a **cache**." }),
    });
    render(<PrsView />);
    fireEvent.click(await screen.findByRole("button", { name: "PR #4 Add cache" }));
    const pane = await screen.findByRole("region", { name: "PR #4" });
    await within(pane).findByText("cache");
    expect(within(pane).getByRole("link", { name: "lint" }).getAttribute("href")).toBe("https://ci/lint");
    expect(within(pane).getByRole("link", { name: /Open in browser/ }).getAttribute("href")).toBe(pr.url);
    fireEvent.click(within(pane).getByRole("button", { name: "Close PR" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "PR #4" })).toBeNull());
  });
});
