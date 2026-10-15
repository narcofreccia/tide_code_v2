import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PrWatch } from "./PrWatch.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const pr = { url: "u", number: 7, state: "open" as const, updatedAt: 1 };

describe("PrWatch", () => {
  it("toggles pr.watch and shows checks, comments and conflicts", () => {
    const fake = attachFakeStore(modelWith({}));
    const thread = makeThread("t1");
    render(<PrWatch thread={thread} pr={{ ...pr, checks: "failure", comments: 3, mergeable: false }} />);
    expect(screen.getByLabelText("checks failing").textContent).toBe("✘");
    expect(screen.getByLabelText("3 comments")).toBeDefined();
    expect(screen.getByLabelText("merge conflict")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Watch PR"));
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "pr.watch", threadId: "t1", enabled: true }),
    );
  });

  it("turns watching off when already watched", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<PrWatch thread={makeThread("t1", { prWatch: { since: 1 } })} pr={pr} />);
    expect((screen.getByLabelText("Watch PR") as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByLabelText("Watch PR"));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });
});
