import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ApprovalCard } from "./ApprovalCard.tsx";
import { attachFakeStore, makeApproval, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const respond = (decision: string) => ({
  type: "approval.respond",
  threadId: "t1",
  requestId: "req-a1",
  decision,
});

describe("ApprovalCard", () => {
  it("dispatches a decision per button", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<ApprovalCard activity={makeApproval("a1")} active />);

    fireEvent.click(screen.getByText("Allow"));
    expect(fake.dispatch).toHaveBeenCalledWith(respond("accept"));
    fireEvent.click(screen.getByText("Allow for session"));
    expect(fake.dispatch).toHaveBeenCalledWith(respond("acceptForSession"));
    fireEvent.click(screen.getByText("Deny"));
    expect(fake.dispatch).toHaveBeenCalledWith(respond("decline"));
  });

  it("answers y / n while it is the live prompt", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<ApprovalCard activity={makeApproval("a1")} active />);
    fireEvent.keyDown(window, { key: "y" });
    expect(fake.dispatch).toHaveBeenCalledWith(respond("accept"));
    fireEvent.keyDown(window, { key: "n" });
    expect(fake.dispatch).toHaveBeenCalledWith(respond("decline"));
  });

  it("ignores y / n when it is not the live prompt", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<ApprovalCard activity={makeApproval("a1")} active={false} />);
    fireEvent.keyDown(window, { key: "y" });
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("renders a unified diff with +/− lines", () => {
    attachFakeStore(modelWith({}));
    render(
      <ApprovalCard
        activity={makeApproval("a1", { diff: "@@ -1 +1 @@\n-old line\n+new line" })}
        active
      />,
    );
    expect(screen.getByLabelText("diff")).toBeDefined();
    expect(screen.getByText("-old line")).toBeDefined();
    expect(screen.getByText("+new line")).toBeDefined();
    expect(screen.getByText("+1 −1")).toBeDefined();
  });

  it("collapses to one line once resolved", () => {
    attachFakeStore(modelWith({}));
    render(
      <ApprovalCard activity={makeApproval("a1", { status: "resolved", decision: "accept" })} active={false} />,
    );
    expect(screen.getByText("Allowed Edit")).toBeDefined();
    expect(screen.queryByText("Allow for session")).toBeNull();
  });
});
