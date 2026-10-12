import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageItem } from "./MessageItem.tsx";
import { attachFakeStore, makeMessage, makeTurn, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("MessageItem", () => {
  it("marks a queued user message and drops it on ×", () => {
    const fake = attachFakeStore(modelWith({}));
    const turn = makeTurn("u2", { status: "queued" });
    render(<MessageItem message={makeMessage("m1", { turnId: "u2", text: "later" })} turn={turn} />);

    expect(screen.getByText("queued")).toBeDefined();
    fireEvent.click(screen.getByLabelText("Remove queued turn"));

    expect(fake.dispatch).toHaveBeenCalledWith({ type: "turn.dequeue", turnId: "u2" });
  });

  it("leaves a running turn's message alone", () => {
    attachFakeStore(modelWith({}));
    render(<MessageItem message={makeMessage("m1")} turn={makeTurn("u1", { status: "running" })} />);
    expect(screen.queryByText("queued")).toBeNull();
  });

  it("renders image attachments as pills", () => {
    attachFakeStore(modelWith({}));
    render(
      <MessageItem
        message={makeMessage("m1", { attachments: [{ mediaType: "image/png", bytes: 122880 }] })}
      />,
    );
    expect(screen.getByText(/image\/png · 120 KB/)).toBeDefined();
  });

  describe("reasoning", () => {
    const reasoning = "first I read the router";

    it("opens while thinking with no answer yet", () => {
      attachFakeStore(modelWith({}));
      render(
        <MessageItem
          message={makeMessage("m1", { role: "assistant", text: "", reasoning, streaming: true })}
        />,
      );
      expect(screen.getByText(reasoning)).toBeDefined();
    });

    it("collapses once the answer starts, and reopens on click", () => {
      attachFakeStore(modelWith({}));
      render(
        <MessageItem
          message={makeMessage("m1", { role: "assistant", text: "the router is here", reasoning })}
        />,
      );
      expect(screen.queryByText(reasoning)).toBeNull();

      fireEvent.click(screen.getByRole("button", { name: /Thinking/ }));
      expect(screen.getByText(reasoning)).toBeDefined();
    });
  });

  describe("turn footer", () => {
    it("shows duration, tokens and cost for a settled turn", () => {
      attachFakeStore(modelWith({}));
      const turn = makeTurn("u1", {
        status: "completed",
        startedAt: 1000,
        settledAt: 3500,
        usage: { inputTokens: 12000, outputTokens: 340, costUsd: 0.0123 },
      });
      render(<MessageItem message={makeMessage("m1", { role: "assistant" })} turn={turn} showMeta />);

      expect(screen.getByText("2.5s")).toBeDefined();
      expect(screen.getByText("↑12.0k ↓340")).toBeDefined();
      expect(screen.getByText("$0.0123")).toBeDefined();
    });

    it("adds cache tokens (read + write) and spells them out on hover", () => {
      attachFakeStore(modelWith({}));
      const turn = makeTurn("u1", {
        status: "completed",
        settledAt: 2,
        usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 8000, cacheWriteTokens: 512 },
      });
      render(<MessageItem message={makeMessage("m1", { role: "assistant" })} turn={turn} showMeta />);
      const tokens = screen.getByText("↑1.2k ↓340 ⟳8.5k");
      expect(tokens.getAttribute("title")).toBe("in 1,200 · out 340 · cache read 8,000 · cache write 512");
    });

    it("shows the error that ended the turn", () => {
      attachFakeStore(modelWith({}));
      const turn = makeTurn("u1", { status: "error", error: "context window exceeded", settledAt: 2 });
      render(<MessageItem message={makeMessage("m1", { role: "assistant" })} turn={turn} showMeta />);
      expect(screen.getByText("context window exceeded")).toBeDefined();
    });

    it("stays quiet without showMeta", () => {
      attachFakeStore(modelWith({}));
      const turn = makeTurn("u1", { status: "running", startedAt: 1, settledAt: 2 });
      render(<MessageItem message={makeMessage("m1", { role: "assistant" })} turn={turn} />);
      expect(screen.queryByText("1ms")).toBeNull();
    });
  });
});
