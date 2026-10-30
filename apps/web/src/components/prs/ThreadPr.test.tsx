import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThreadHeader } from "../thread/ThreadHeader.tsx";
import { LinkPrDialogHost } from "./LinkPrDialog.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { useToasts } from "../../state/toast.ts";
import { comment, detail, makePr } from "./testFixtures.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function mount(patch: Parameters<typeof makeThread>[1] = {}) {
  const thread = makeThread("t1", patch);
  const fake = attachFakeStore(modelWith({ threads: { t1: thread } }));
  render(
    <>
      <ThreadHeader thread={thread} />
      <LinkPrDialogHost />
    </>,
  );
  return fake;
}

const openMenu = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "More actions" }));
};

describe("thread header: PR actions", () => {
  it("Link a PR… opens a dialog that calls pr.link and closes", async () => {
    const rpc = mockRpc({ "thread.terminalCommand": () => ({}), "pr.link": () => ({ pr: makePr(42) }) });
    mount();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Link a PR…" }));
    expect(useUi.getState().linkPrThreadId).toBe("t1");
    const input = screen.getByRole("textbox", { name: "PR number or URL" });
    fireEvent.change(input, { target: { value: " 42 " } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Link" }));
    });
    expect(rpc).toHaveBeenCalledWith("pr.link", { threadId: "t1", pr: "42" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(useToasts.getState().toasts.map((t) => t.text)).toContain("Linked PR #42");
  });

  it("keeps the dialog open with the server's refusal", async () => {
    mockRpc({
      "thread.terminalCommand": () => ({}),
      "pr.link": () => {
        throw new Error("no such PR on acme/app");
      },
    });
    mount();
    openMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: "Link a PR…" }));
    fireEvent.change(screen.getByRole("textbox", { name: "PR number or URL" }), { target: { value: "999" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Link" }));
    });
    expect((await screen.findByRole("alert")).textContent).toBe("no such PR on acme/app");
    expect(screen.getByRole("dialog")).toBeDefined();
  });

  it("offers Address review comments only for an open PR with comments, and sends them as a PR notice", async () => {
    const pr = makePr(5, { comments: 2 });
    const rpc = mockRpc({
      "thread.terminalCommand": () => ({}),
      "pr.detail": () => detail(pr, { comments: [comment("c1", { kind: "review-comment", path: "a.ts", line: 3, body: "rename" })] }),
    });
    const fake = mount({ pr });
    openMenu();
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Address review comments" }));
    });
    expect(rpc).toHaveBeenCalledWith("pr.detail", { projectId: "p1", number: 5 });
    await waitFor(() => expect(fake.dispatch).toHaveBeenCalled());
    expect(fake.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "turn.request",
      threadId: "t1",
      notification: { source: "pr", summary: "Address review comments on #5" },
    });
    cleanup();

    mount({ pr: makePr(6, { comments: 0 }) });
    openMenu();
    expect(screen.queryByRole("menuitem", { name: "Address review comments" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Link a different PR…" })).toBeDefined();
  });
});
