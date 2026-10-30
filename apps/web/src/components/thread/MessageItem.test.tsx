import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MessageItem, splitStreamingTail } from "./MessageItem.tsx";
import { MarkdownPre } from "./VisualBlocks.tsx";
import { useUi } from "../../state/ui.ts";
import { attachFakeStore, makeMessage, makeTurn, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("MessageItem", () => {
  it("marks a queued user message passively, with no remove control", () => {
    attachFakeStore(modelWith({}));
    const turn = makeTurn("u2", { status: "queued" });
    render(<MessageItem message={makeMessage("m1", { turnId: "u2", text: "later" })} turn={turn} />);

    expect(screen.getByText("queued")).toBeDefined();
    expect(screen.queryByLabelText("Remove queued turn")).toBeNull();
    expect(screen.queryByTitle("Turn actions")).toBeNull();
  });

  it("offers fork and rollback on a settled turn", () => {
    attachFakeStore(modelWith({}));
    render(<MessageItem message={makeMessage("m1", { turnId: "u1" })} turn={makeTurn("u1")} />);
    fireEvent.click(screen.getByTitle("Turn actions"));
    fireEvent.click(screen.getByText("Rollback to before this turn…"));
    expect(useUi.getState().threadDialog).toEqual({ kind: "rollback", threadId: "t1", turnId: "u1" });
    fireEvent.click(screen.getByTitle("Turn actions"));
    fireEvent.click(screen.getByText("Fork from here…"));
    expect(useUi.getState().threadDialog).toEqual({ kind: "fork", threadId: "t1", turnId: "u1" });
  });

  it("hides the turn menu while the turn runs", () => {
    attachFakeStore(modelWith({}));
    render(<MessageItem message={makeMessage("m1")} turn={makeTurn("u1", { status: "running" })} />);
    expect(screen.queryByTitle("Turn actions")).toBeNull();
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

  describe("streaming motion", () => {
    const words = (n: number): string => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");
    const markdownOf = (container: HTMLElement): HTMLElement =>
      container.querySelector("[data-role=assistant] > div") as HTMLElement;

    it("marks the markdown while streaming and holds out the last words", () => {
      attachFakeStore(modelWith({}));
      const text = `Intro paragraph.\n\n${words(20)}`;
      const { container } = render(
        <MessageItem message={makeMessage("m1", { role: "assistant", text, streaming: true })} />,
      );
      const markdown = markdownOf(container);
      expect(markdown.hasAttribute("data-streaming")).toBe(true);
      const tail = container.querySelector("[data-stream-tail]");
      expect(tail?.textContent).toBe(` ${words(20).split(" ").slice(8).join(" ")}`);
      expect(tail?.children).toHaveLength(12);
      // prefix + tail read back as the whole reply
      expect(`${markdown.textContent ?? ""}${tail?.textContent ?? ""}`).toBe(`Intro paragraph.\n${words(20)}`);
    });

    it("renders a finished reply exactly as plain markdown: no attributes, no tail", () => {
      attachFakeStore(modelWith({}));
      const text = "# Title\n\nSome **bold** text and `code`.\n\n```ts\nconst a = 1;\n```\n\n- one\n- two\n\n" + words(20);
      const { container } = render(<MessageItem message={makeMessage("m1", { role: "assistant", text })} />);
      const markdown = markdownOf(container);
      expect(markdown.hasAttribute("data-streaming")).toBe(false);
      expect(markdown.hasAttribute("data-tail")).toBe(false);
      expect(container.querySelector("[data-stream-tail]")).toBeNull();
      expect(container.querySelector("[aria-label=streaming]")).toBeNull();

      const reference = render(
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: MarkdownPre }}>
          {text}
        </ReactMarkdown>,
      );
      expect(markdown.innerHTML).toBe(reference.container.innerHTML);
    });

    it("never splits inside an open code fence", () => {
      const text = `Here is code:\n\n\`\`\`sh\n${words(20)}`;
      expect(splitStreamingTail(text)).toBeUndefined();
      attachFakeStore(modelWith({}));
      const { container } = render(
        <MessageItem message={makeMessage("m1", { role: "assistant", text, streaming: true })} />,
      );
      expect(container.querySelector("[data-stream-tail]")).toBeNull();
      expect(markdownOf(container).hasAttribute("data-streaming")).toBe(true);
    });

    it("splits again once the fence is closed and prose follows", () => {
      const text = `\`\`\`sh\nls\n\`\`\`\n\n${words(5)}`;
      expect(splitStreamingTail(text)).toEqual({ prefix: `\`\`\`sh\nls\n\`\`\`\n\nw0`, tail: " w1 w2 w3 w4" });
    });

    it.each([
      ["a list item", `- ${words(15)}`],
      ["a heading", `## ${words(15)}`],
      ["a quote", `> ${words(15)}`],
      ["an indented continuation", `- item\n\n  ${words(15)}`],
      ["a table", `a | b\n--|--\n${words(15)}`],
      ["inline syntax in the tail", `${words(15)} **bold**`],
      ["a link in the tail", `${words(15)} https://example.com`],
      ["a line too short to split", "hi there friend"],
      ["a trailing newline", `${words(15)}\n`],
    ])("leaves %s to markdown", (_label, text) => {
      expect(splitStreamingTail(text)).toBeUndefined();
    });

    it("keys tail words by offset so earlier words survive a new token", () => {
      attachFakeStore(modelWith({}));
      const message = makeMessage("m1", { role: "assistant", text: words(20), streaming: true });
      const { container, rerender } = render(<MessageItem message={message} />);
      const before = container.querySelector("[data-stream-tail]")?.lastElementChild;
      rerender(<MessageItem message={{ ...message, text: `${words(20)} next` }} />);
      const spans = [...(container.querySelector("[data-stream-tail]")?.children ?? [])];
      expect(spans.at(-1)?.textContent).toBe(" next");
      expect(spans).toContain(before);
    });

    it("shows words already on screen without the fade when the tail resumes after syntax", () => {
      attachFakeStore(modelWith({}));
      // the 12-word window still holds the code span: everything is markdown
      const before = `${words(15)} \`x\` a b c d e f g h i j k`;
      const message = makeMessage("m1", { role: "assistant", text: before, streaming: true });
      const { container, rerender } = render(<MessageItem message={message} />);
      expect(container.querySelector("[data-stream-tail]")).toBeNull();

      // one more word pushes the code span out: the tail is back
      rerender(<MessageItem message={{ ...message, text: `${before} l` }} />);
      const spans = [...(container.querySelector("[data-stream-tail]")?.children ?? [])];
      expect(spans.map((span) => span.textContent).join("")).toBe(" a b c d e f g h i j k l");
      expect(spans.slice(0, -1).every((span) => span.hasAttribute("data-seen"))).toBe(true);
      expect(spans.at(-1)?.hasAttribute("data-seen")).toBe(false);

      // a fresh word keeps fading even after a re-render
      rerender(<MessageItem message={{ ...message, text: `${before} l m` }} />);
      const after = [...(container.querySelector("[data-stream-tail]")?.children ?? [])];
      expect(after.at(-2)).toBe(spans.at(-1));
      expect(after.at(-2)?.hasAttribute("data-seen")).toBe(false);
    });

    it("shimmers the Thinking label while the model thinks with no answer yet", () => {
      attachFakeStore(modelWith({}));
      const { container } = render(
        <MessageItem message={makeMessage("m1", { role: "assistant", text: "", reasoning: "hm", streaming: true })} />,
      );
      expect(screen.getByRole("button", { name: "Thinking…" })).toBeDefined();
      expect(container.querySelector("[data-live-label]")).not.toBeNull();
    });
  });
});
