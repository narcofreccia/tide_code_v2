import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ErrorBoundary, buildReport, safeUrl } from "./ErrorBoundary.tsx";

afterEach(cleanup);

function Boom(): never {
  throw new Error("kaboom");
}

describe("ErrorBoundary", () => {
  it("shows the error screen for a throwing child and copies a report", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText("Tide hit an error")).toBeTruthy();
    expect(screen.getByText("kaboom")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("kaboom"));
  });

  it("renders children when nothing throws", () => {
    render(<ErrorBoundary>fine</ErrorBoundary>);
    expect(screen.getByText("fine")).toBeTruthy();
  });

  it("strips credentials from the reported URL", () => {
    expect(safeUrl("http://x/?token=abc&wsTicket=d&a=1")).toBe("http://x/?a=1");
    expect(buildReport("t", "d")).not.toContain("token=");
  });
});
