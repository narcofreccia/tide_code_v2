import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MessageItem } from "./MessageItem.tsx";
import { makeMessage } from "../../testHarness.ts";

const mermaid = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn() }));
vi.mock("mermaid", () => ({ default: mermaid }));

afterEach(() => {
  cleanup();
  mermaid.initialize.mockReset();
  mermaid.render.mockReset();
});

function reply(text: string) {
  return render(
    <ul>
      <MessageItem message={makeMessage("m1", { role: "assistant", text })} />
    </ul>,
  );
}

describe("visual replies", () => {
  it("renders an html fence in a sandboxed iframe without allow-same-origin", () => {
    reply("Here:\n\n```html\n<h1>Hi</h1><script>document.body.append('x')</script>\n```\n");
    const frame = screen.getByTitle("HTML preview") as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Hi</h1>");
    expect(frame.getAttribute("height")).toBe("320");
    expect(screen.queryByText(/<h1>Hi<\/h1>/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(screen.getByText(/<h1>Hi<\/h1>/)).toBeDefined();
  });

  it("leaves other fences as code", () => {
    const { container } = reply("```ts\nconst a = 1;\n```\n");
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toContain("const a = 1;");
  });

  it("renders a mermaid fence through mermaid in strict mode", async () => {
    mermaid.render.mockResolvedValue({ svg: '<svg data-testid="diagram"></svg>' });
    reply("```mermaid\ngraph TD; A-->B\n```\n");
    await waitFor(() => expect(screen.getByRole("img", { name: "Diagram" }).innerHTML).toContain("<svg"));
    expect(mermaid.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", startOnLoad: false }));
    expect(mermaid.render).toHaveBeenCalledWith(expect.stringMatching(/^tide-mermaid-/), "graph TD; A-->B");
  });

  it("falls back to the code block when mermaid fails", async () => {
    mermaid.render.mockRejectedValue(new Error("Parse error"));
    const { container } = reply("```mermaid\nnot a diagram\n```\n");
    await waitFor(() => expect(container.querySelector('pre[data-mermaid="error"]')).not.toBeNull());
    expect(container.querySelector("pre code")?.textContent).toBe("not a diagram");
    expect(screen.queryByRole("img", { name: "Diagram" })).toBeNull();
  });
});
