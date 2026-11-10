import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Thread } from "@tide/contracts";
import { Composer } from "./Composer.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { attachFakeStore, makePlan, makeThread, makeTurn, modelWithTurns, resetUi } from "../../testHarness.ts";
import { resetDrafts } from "../../state/drafts.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  resetDrafts();
  cleanup();
  resetUi();
});

const merged = { branch: "tide/t1", baseBranch: "main", mergedAt: 5, merge: { status: "merged" as const, strategy: "squash" as const, at: 5 } };

function mount(patch: Partial<Thread>) {
  const thread = makeThread("t1", { latestTurnId: "u1", ...patch });
  const fake = attachFakeStore(modelWithTurns(thread, [makeTurn("u1")]));
  render(<Composer thread={thread} />);
  return fake;
}

const sendButton = (): HTMLButtonElement => screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

describe("Composer on a thread whose worktree is gone", () => {
  it("merged back: send is off, it says why and offers to continue in a new thread", () => {
    const fake = mount(merged);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "one more thing" } });
    expect(sendButton().disabled).toBe(true);
    expect(sendButton().title).toBe("This thread's worktree was removed after the merge.");
    expect(screen.getByText("This thread's worktree was removed after the merge.")).toBeDefined();

    // ↵, ⌘⇧↵ (background) and ⌥↵ all go nowhere
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true, shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", altKey: true });
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect((input as HTMLTextAreaElement).value).toBe("one more thing");

    fireEvent.click(screen.getByRole("button", { name: "Continue in a new thread" }));
    expect(useUi.getState().threadDialog).toEqual({ kind: "fork", threadId: "t1", turnId: "u1" });
  });

  it("detached without a merge says so", () => {
    mount({ branch: "tide/t1" });
    expect(screen.getByText("This thread's worktree was removed.")).toBeDefined();
    expect(screen.getByRole("button", { name: "Continue in a new thread" })).toBeDefined();
  });

  it("a thread in its worktree is unaffected", () => {
    const fake = mount({ worktreePath: "/wt/t1", branch: "tide/t1" });
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "go" } });
    expect(sendButton().disabled).toBe(false);
    expect(screen.queryByText(/worktree was removed/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Continue in a new thread" })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.request", text: "go" }));
  });

  it("the plan card's Implement here is off for the same reason", () => {
    const thread = makeThread("t1", merged);
    attachFakeStore(modelWithTurns(thread, [makeTurn("u1")]));
    render(
      <ul>
        <PlanCard plan={makePlan("pl1", { threadId: "t1" })} provider="claude" />
      </ul>,
    );
    const implement = screen.getByRole("button", { name: "Implement" }) as HTMLButtonElement;
    expect(implement.disabled).toBe(true);
    expect(implement.title).toBe("This thread's worktree was removed after the merge.");
  });
});
