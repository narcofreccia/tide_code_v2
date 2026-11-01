import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { Markdown } from "./Markdown.tsx";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(() => new Promise(() => undefined)) }));
vi.mock("mermaid", () => ({ default: mermaid }));

/** every text react-markdown was asked to parse, in order */
const parsed = vi.hoisted(() => [] as string[]);
vi.mock("react-markdown", async (importOriginal) => {
  const real = await importOriginal<typeof import("react-markdown")>();
  const Counted = (props: Parameters<typeof real.default>[0]) => {
    parsed.push(String(props.children ?? ""));
    return real.default(props);
  };
  return { ...real, default: Counted };
});

afterEach(() => {
  cleanup();
  parsed.length = 0;
});

function html(text: string, streaming: boolean): string {
  return render(
    <div>
      <Markdown text={text} streaming={streaming} />
    </div>,
  ).container.innerHTML;
}

const SAMPLES = [
  "# Title\n\nPara one with **bold** and `code`.\n\n- a\n- b\n\nPara two\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\nend\n",
  "- a\n\n- b\n\n  continued\n\n1. x\n\n2. y\n\nafter\n",
  "> quote\n\n> again\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\ntext and more text",
  "see [x] and a note[^1]\n\n[x]: https://example.com\n\n[^1]: the note\n",
  "One.\n\nTwo is still being wri",
];

describe("Markdown", () => {
  it.each(SAMPLES)("renders the same DOM streaming (in blocks) as settled (one parse): %#", (text) => {
    const settled = html(text, false);
    cleanup();
    expect(html(text, true)).toBe(settled);
  });

  it("re-parses only the open block on a delta", () => {
    const head = "First paragraph.\n\nSecond paragraph.\n\nThird";
    const { rerender } = render(<Markdown text={head} streaming />);
    parsed.length = 0;
    rerender(<Markdown text={`${head} grows`} streaming />);
    expect(parsed).toEqual(["Third grows"]);
  });

  it("does not parse again when nothing changed", () => {
    const { rerender } = render(<Markdown text="Settled reply." />);
    parsed.length = 0;
    rerender(<Markdown text="Settled reply." />);
    expect(parsed).toEqual([]);
  });

  it("keeps a mermaid fence as plain code while it is open, draws it once closed", () => {
    const open = "Diagram:\n\n```mermaid\ngraph TD\nA-->B";
    const { container, rerender } = render(<Markdown text={open} streaming />);
    expect(container.querySelector("[data-mermaid]")).toBeNull();
    expect(container.querySelector("pre code.language-mermaid")?.textContent).toContain("A-->B");
    expect(mermaid.render).not.toHaveBeenCalled();
    rerender(<Markdown text={`${open}\n\`\`\`\n`} streaming />);
    expect(container.querySelector("[data-mermaid]")).not.toBeNull();
  });

  it("keeps an html fence as plain code while it is open", () => {
    const { container, rerender } = render(<Markdown text={"Page:\n\n```html\n<h1>Hi</h1>"} streaming />);
    expect(container.querySelector("iframe")).toBeNull();
    rerender(<Markdown text={"Page:\n\n```html\n<h1>Hi</h1>"} />);
    expect(container.querySelector("iframe")).not.toBeNull();
  });
});
