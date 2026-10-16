import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Logo } from "./Logo.tsx";
import { TopBar } from "./TopBar.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Logo", () => {
  it("draws the mark and the word at the asked height, text taking the surrounding colour", () => {
    const { container } = render(<Logo size={40} className="x" />);
    const svg = container.querySelector("svg") as SVGSVGElement;
    expect(svg.getAttribute("height")).toBe("40");
    expect(Number(svg.getAttribute("width"))).toBeGreaterThan(40);
    expect(svg.getAttribute("class")).toBe("x");
    const text = svg.querySelector("text") as SVGTextElement;
    expect(text.textContent).toBe("code");
    expect(text.getAttribute("fill")).toBe("currentColor");
    expect(text.getAttribute("font-weight")).toBe("700");
    // the mark keeps its brand gradient
    expect(svg.querySelectorAll("path")).toHaveLength(2);
    expect(svg.querySelectorAll("linearGradient")).toHaveLength(2);
  });

  it("defaults to the 18px top-bar size", () => {
    const { container } = render(<Logo />);
    expect(container.querySelector("svg")?.getAttribute("height")).toBe("18");
  });

  it("goes back to Mission Control from the top bar", () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(<TopBar />);
    fireEvent.click(screen.getByLabelText("Tide — Mission Control"));
    expect(useUi.getState().view).toBe("mission");
    expect(useUi.getState().selectedThreadId).toBeNull();
  });
});
