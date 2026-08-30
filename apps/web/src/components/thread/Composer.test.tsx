import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Composer", () => {
  it("sends a turn with ⌘↵", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "turn.request", threadId: "t1", text: "go" });
  });

  it("becomes Stop while the thread runs and interrupts the turn", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    expect(screen.queryByText("Send")).toBeNull();
    fireEvent.click(screen.getByText("Stop"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "turn.interrupt", threadId: "t1" });
  });

  it("interrupts on Esc while running", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "turn.interrupt", threadId: "t1" });
  });

  it("disables the pills while running", () => {
    attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    expect(screen.getByLabelText<HTMLSelectElement>("Provider").disabled).toBe(true);
  });

  it("grows the textarea up to eight rows", () => {
    attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Message");
    expect(input.rows).toBe(3);
    fireEvent.change(input, { target: { value: "a\n".repeat(20) } });
    expect(input.rows).toBe(8);
  });
});
