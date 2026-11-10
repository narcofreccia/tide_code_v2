import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MessageItem } from "./MessageItem.tsx";
import { Markdown } from "./Markdown.tsx";
import { attachFakeStore, makeMessage, makeTurn, modelWith, resetUi } from "../../testHarness.ts";

const copyWithToast = vi.fn(async (_text: string, _success?: string) => true);
vi.mock("../../lib/clipboard.ts", () => ({ copyWithToast: (text: string, success?: string) => copyWithToast(text, success) }));

afterEach(() => {
  cleanup();
  resetUi();
  copyWithToast.mockClear();
});

describe("copy tools in the stream", () => {
  it("copies an assistant reply's Markdown source", () => {
    attachFakeStore(modelWith({}));
    const text = "Here is **the fix**:\n\n```ts\nconst a = 1;\n```";
    render(<MessageItem message={makeMessage("m1", { role: "assistant", text })} turn={makeTurn("u1")} />);
    fireEvent.click(screen.getByLabelText("Copy reply"));
    expect(copyWithToast).toHaveBeenCalledWith(text, undefined);
  });

  it("copies a user message as typed", () => {
    attachFakeStore(modelWith({}));
    const text = "fix  the\n  login";
    render(<MessageItem message={makeMessage("m1", { text })} turn={makeTurn("u1")} />);
    fireEvent.click(screen.getByLabelText("Copy message"));
    expect(copyWithToast).toHaveBeenCalledWith(text, undefined);
  });

  it("has no copy tool on a reply still streaming", () => {
    attachFakeStore(modelWith({}));
    render(<MessageItem message={makeMessage("m1", { role: "assistant", text: "partial", streaming: true })} />);
    expect(screen.queryByLabelText("Copy reply")).toBeNull();
  });

  it("copies a code block's exact code, without the closing newline", () => {
    render(<Markdown text={"Run:\n\n```sh\npnpm i\npnpm test\n```\n"} />);
    fireEvent.click(screen.getByLabelText("Copy code"));
    expect(copyWithToast).toHaveBeenCalledWith("pnpm i\npnpm test", undefined);
  });

  it("is reachable by Tab but a mouse press does not move focus", () => {
    render(<Markdown text={"```\nx\n```"} />);
    const button = screen.getByLabelText("Copy code");
    expect(button.tabIndex).toBe(0);
    const pressed = fireEvent.mouseDown(button);
    expect(pressed).toBe(false); // default prevented: focus stays in the composer
  });
});
