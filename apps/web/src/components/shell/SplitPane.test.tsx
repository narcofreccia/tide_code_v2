import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { resetUi } from "../../testHarness.ts";
import { SplitPane } from "./SplitPane.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("SplitPane", () => {
  it("roots the thread/workbench split in the `split` class that fills the content column", () => {
    render(<SplitPane primary={<p>thread</p>} secondary={<p>workbench</p>} />);
    const root = screen.getByRole("separator").parentElement;
    expect(root?.className).toMatch(/split/);
    expect(root?.contains(screen.getByText("thread"))).toBe(true);
    expect(root?.contains(screen.getByText("workbench"))).toBe(true);
  });
});
