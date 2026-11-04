import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { UserInputCard } from "./UserInputCard.tsx";
import { attachFakeStore, makeUserInput, mockRpc, modelWith, resetUi } from "../../testHarness.ts";

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

describe("UserInputCard: secret (R16)", () => {
  const secret = (patch: Parameters<typeof makeUserInput>[2] = {}) =>
    makeUserInput("s1", [{ id: "GITHUB_TOKEN", text: "Push the release branch" }], { secret: true, requestId: "secret:1", ...patch });

  it("renders a masked input and sends the value only over secret.provide", async () => {
    const fake = attachFakeStore(modelWith({}));
    const rpc = mockRpc({ "secret.provide": () => ({ ok: true }) });
    render(<UserInputCard activity={secret()} />);
    expect(screen.getByText("Push the release branch")).toBeTruthy();
    const input = screen.getByLabelText("GITHUB_TOKEN") as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    const provide = screen.getByRole("button", { name: "Provide" }) as HTMLButtonElement;
    expect(provide.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "ghp_abc" } });
    expect(provide.disabled).toBe(false);
    fireEvent.click(provide);
    expect(rpc).toHaveBeenCalledWith("secret.provide", { threadId: "t1", requestId: "secret:1", value: "ghp_abc" });
    expect(fake.dispatch).not.toHaveBeenCalled();
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("declines through user-input.respond without a value", () => {
    const fake = attachFakeStore(modelWith({}));
    const rpc = mockRpc({});
    render(<UserInputCard activity={secret()} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "user-input.respond", threadId: "t1", requestId: "secret:1", answers: { decided: "declined" } });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("reads the decision once resolved", () => {
    attachFakeStore(modelWith({}));
    const { unmount } = render(<UserInputCard activity={secret({ status: "resolved", answers: { decided: "provided" } })} />);
    expect(screen.getByText("GITHUB_TOKEN · provided")).toBeTruthy();
    unmount();
    render(<UserInputCard activity={secret({ status: "resolved", answers: { decided: "declined" } })} />);
    expect(screen.getByText("GITHUB_TOKEN · declined")).toBeTruthy();
  });

  it("works on a child's card answered from the parent", () => {
    attachFakeStore(modelWith({}));
    const rpc = mockRpc({ "secret.provide": () => ({ ok: true }) });
    render(<UserInputCard activity={secret({ threadId: "child" })} from={{ title: "Deployer", onOpen: () => undefined }} />);
    expect(screen.getByText("Deployer")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("GITHUB_TOKEN"), { target: { value: "v" } });
    fireEvent.click(screen.getByRole("button", { name: "Provide" }));
    expect(rpc).toHaveBeenCalledWith("secret.provide", { threadId: "child", requestId: "secret:1", value: "v" });
  });
});
