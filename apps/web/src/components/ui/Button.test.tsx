import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "./Button.tsx";

afterEach(cleanup);

describe("Button", () => {
  it("renders a type=button with the ghost look by default", () => {
    render(<Button>Go</Button>);
    const button = screen.getByRole("button", { name: "Go" });
    expect(button.getAttribute("type")).toBe("button");
    expect(button.className).toMatch(/ghost/);
  });

  it("has a link variant for inline accent actions", () => {
    const onClick = vi.fn();
    render(
      <Button variant="link" className="extra" onClick={onClick}>
        open as thread
      </Button>,
    );
    const button = screen.getByRole("button", { name: "open as thread" });
    expect(button.className).toMatch(/link/);
    expect(button.className).toMatch(/extra/);
    expect(button.className).not.toMatch(/ghost/);
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
