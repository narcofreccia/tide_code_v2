import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { UserInputCard } from "./UserInputCard.tsx";
import { attachFakeStore, makeUserInput, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("UserInputCard", () => {
  it("answers a single-choice question on click", () => {
    const fake = attachFakeStore(modelWith({}));
    render(
      <UserInputCard
        activity={makeUserInput("q1", [
          { id: "why", text: "Which approach?", options: [{ label: "rewrite" }, { label: "patch" }] },
        ])}
      />,
    );
    fireEvent.click(screen.getByText("patch"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "user-input.respond",
      threadId: "t1",
      requestId: "req-q1",
      answers: { why: "patch" },
    });
  });

  it("collects checkboxes for a multi-select question", () => {
    const fake = attachFakeStore(modelWith({}));
    render(
      <UserInputCard
        activity={makeUserInput("q2", [
          {
            id: "files",
            text: "Which files?",
            multi: true,
            options: [{ label: "a.ts" }, { label: "b.ts" }],
          },
        ])}
      />,
    );
    fireEvent.click(screen.getByLabelText("a.ts"));
    fireEvent.click(screen.getByLabelText("b.ts"));
    fireEvent.click(screen.getByText("Send answer"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "user-input.respond",
      threadId: "t1",
      requestId: "req-q2",
      answers: { files: ["a.ts", "b.ts"] },
    });
  });

  it("falls back to free text when the harness sends no options", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<UserInputCard activity={makeUserInput("q3", [{ id: "note", text: "Anything else?" }])} />);
    fireEvent.change(screen.getByLabelText("Anything else?"), { target: { value: "ship it" } });
    fireEvent.click(screen.getByText("Send answer"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "user-input.respond",
      threadId: "t1",
      requestId: "req-q3",
      answers: { note: "ship it" },
    });
  });
});
