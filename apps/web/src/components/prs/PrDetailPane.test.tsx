import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PullRequest } from "@tide/contracts";
import { PrDetailPane } from "./PrDetailPane.tsx";
import { entryKey, resetPrs, type PrEntry } from "./prData.ts";
import { attachFakeStore, chooseOption, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useToasts } from "../../state/toast.ts";
import { comment, detail, makePr } from "./testFixtures.ts";

vi.mock("../workbench/monaco/MonacoDiff.tsx", () => ({
  MonacoDiff: ({ original, modified }: { original: string; modified: string }) => (
    <pre data-testid="monaco-diff">{`${original}|||${modified}`}</pre>
  ),
}));

afterEach(() => {
  cleanup();
  resetUi();
  resetPrs();
});

function entry(pr: PullRequest, threadId?: string): PrEntry {
  return { projectId: "p1", pr, key: entryKey(undefined, "p1", pr.number), ...(threadId ? { threadId } : {}) };
}

function setup(pr: PullRequest, handlers: Parameters<typeof mockRpc>[0] = {}, threadId?: string) {
  const fake = attachFakeStore(
    modelWith({
      projects: { p1: { id: "p1", title: "App", rootPath: "/src/app", createdAt: 1, updatedAt: 1 } },
      threads: { t1: makeThread("t1", { title: "Fix login" }) },
    }),
  );
  const rpc = mockRpc({
    "pr.detail": () => detail(pr),
    "pr.list": () => ({ items: [], fetchedAt: 1 }),
    ...handlers,
  });
  render(<PrDetailPane entry={entry(pr, threadId)} onClose={() => undefined} />);
  return { rpc, fake };
}

const toasts = (): string[] => useToasts.getState().toasts.map((t) => t.text);

describe("PrDetailPane actions", () => {
  it("merges after confirming, with the chosen method and branch deletion", async () => {
    const pr = makePr(7, { mergeable: true, checks: "success" });
    const { rpc } = setup(pr, { "pr.merge": () => ({ merged: true }) });
    await screen.findByText("Because.");
    chooseOption("Merge method", "Rebase and merge");
    fireEvent.click(screen.getByRole("checkbox", { name: "Delete branch" }));
    fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
    const dialog = screen.getByRole("dialog", { name: "Merge #7" });
    expect(rpc).not.toHaveBeenCalledWith("pr.merge", expect.anything());
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Merge" }));
    });
    expect(rpc).toHaveBeenCalledWith("pr.merge", { projectId: "p1", number: 7, method: "rebase", deleteBranch: false });
    await waitFor(() => expect(toasts()).toContain("Merged #7"));
    // refetches the PR and the list
    expect(rpc.mock.calls.filter(([m]) => m === "pr.detail").length).toBeGreaterThan(1);
    expect(rpc).toHaveBeenCalledWith("pr.list", { state: "open" });
  });

  it("blocks merge on failing checks unless Merge anyway, and never on conflicts", async () => {
    setup(makePr(8, { checkRuns: [{ name: "test", status: "failure" }] }));
    await screen.findByText("Because.");
    const merge = screen.getByRole("button", { name: "Merge…" }) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    expect(screen.getByText("Can't merge: checks are failing")).toBeDefined();
    fireEvent.click(screen.getByRole("checkbox", { name: "Merge anyway" }));
    expect(merge.disabled).toBe(false);
    cleanup();

    setup(makePr(9, { mergeable: false }));
    await screen.findByText("Because.");
    expect((screen.getByRole("button", { name: "Merge…" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("checkbox", { name: "Merge anyway" })).toBeNull();
  });

  it("surfaces a refused merge", async () => {
    setup(makePr(10, { checks: "success" }), { "pr.merge": () => ({ merged: false, error: "base branch protected" }) });
    await screen.findByText("Because.");
    fireEvent.click(screen.getByRole("button", { name: "Merge…" }));
    await act(async () => {
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Merge" }));
    });
    await waitFor(() => expect(toasts()).toContain("Merging #10 failed: base branch protected"));
  });

  it("approves, requests changes and comments", async () => {
    const { rpc } = setup(makePr(11), { "pr.review": () => ({ ok: true }), "pr.comment": () => ({ ok: true }) });
    await screen.findByText("Because.");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    });
    expect(rpc).toHaveBeenCalledWith("pr.review", { projectId: "p1", number: 11, event: "approve" });

    const box = screen.getByRole("textbox", { name: "Comment" });
    expect((screen.getByRole("button", { name: "Request changes" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Rename this" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    });
    expect(rpc).toHaveBeenCalledWith("pr.review", { projectId: "p1", number: 11, event: "request_changes", body: "Rename this" });

    fireEvent.change(screen.getByRole("textbox", { name: "Comment" }), { target: { value: "LGTM" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Comment" }));
    });
    expect(rpc).toHaveBeenCalledWith("pr.comment", { projectId: "p1", number: 11, body: "LGTM" });
  });

  it("links an unlinked PR to a picked thread", async () => {
    const pr = makePr(12);
    const { rpc } = setup(pr, { "pr.link": () => ({ pr }) });
    await screen.findByText("Because.");
    fireEvent.click(screen.getByRole("button", { name: "Link to thread…" }));
    chooseOption("Thread to link", "Fix login");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Link" }));
    });
    expect(rpc).toHaveBeenCalledWith("pr.link", { threadId: "t1", pr: pr.url });
  });

  it("asks the linked thread to address the review comments", async () => {
    const pr = makePr(13);
    const { fake } = setup(
      pr,
      {
        "pr.detail": () =>
          detail(pr, {
            comments: [
              comment("c1", { kind: "review-comment", path: "src/a.ts", line: 4, body: "Use a const" }),
              comment("c2", { kind: "review", reviewState: "approved", body: "nice" }),
            ],
          }),
      },
      "t1",
    );
    expect(screen.getByRole("button", { name: "Open thread" })).toBeDefined();
    const ask = await screen.findByRole("button", { name: "Ask the thread to address comments" });
    await act(async () => {
      fireEvent.click(ask);
    });
    const sent = fake.dispatch.mock.calls[0]?.[0] as { type: string; threadId: string; text: string; notification: unknown };
    expect(sent.type).toBe("turn.request");
    expect(sent.threadId).toBe("t1");
    expect(sent.text).toContain("**bob** on `src/a.ts:4`:\n> Use a const");
    expect(sent.text).not.toContain("nice");
    expect(sent.notification).toEqual({ source: "pr", summary: "Address review comments on #13" });
  });

  it("shows files from pr.diff through the workbench file list and the diff viewer", async () => {
    const pr = makePr(14, { changedFiles: 2 });
    const { rpc } = setup(pr, {
      "pr.diff": () => ({
        base: "a",
        head: "b",
        files: [
          { path: "src/a.ts", status: "modified", additions: 1, deletions: 1, patch: "@@ -1,2 +1,2 @@\n keep\n-old\n+new\n" },
          { path: "src/new.ts", status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+hello\n" },
        ],
      }),
    });
    fireEvent.click(screen.getByRole("tab", { name: "Files · 2" }));
    expect(rpc).toHaveBeenCalledWith("pr.diff", { projectId: "p1", number: 14 });
    const diff = await screen.findByTestId("monaco-diff");
    expect(diff.textContent).toBe("⋯ @@ -1,2 +1,2 @@\nkeep\nold|||⋯ @@ -1,2 +1,2 @@\nkeep\nnew");
    fireEvent.click(screen.getByRole("option", { name: /new\.ts/ }));
    expect(screen.getByTestId("patch-view").textContent).toContain("+hello");
  });

  it("threads comments by path and line, with review states", async () => {
    const pr = makePr(15);
    setup(pr, {
      "pr.detail": () =>
        detail(pr, {
          comments: [
            comment("c1", { kind: "review", reviewState: "changes_requested", body: "Needs work" }),
            comment("c2", { kind: "review-comment", path: "src/a.ts", line: 4, body: "first", createdAt: 1 }),
            comment("c3", { kind: "review-comment", path: "src/a.ts", line: 4, body: "reply", createdAt: 2 }),
          ],
        }),
    });
    await screen.findByText("Because.");
    fireEvent.click(screen.getByRole("tab", { name: "Comments · 3" }));
    const thread = screen.getByRole("region", { name: "src/a.ts:4" });
    expect(within(thread).getAllByRole("listitem").map((li) => li.textContent?.includes("first") || li.textContent?.includes("reply"))).toEqual([true, true]);
    expect(screen.getByText("review: changes requested")).toBeDefined();
  });
});
