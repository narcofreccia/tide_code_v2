import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useModel } from "../../state/model.ts";
import { BootGate } from "./BootGate.tsx";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("BootGate", () => {
  it("shows nothing extra when the connection opens before 8 s", () => {
    useModel.setState({ status: "connecting" });
    render(<BootGate>app</BootGate>);
    expect(screen.getByText("app")).toBeTruthy();
    useModel.setState({ status: "open" });
    act(() => void vi.advanceTimersByTime(8000));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("overlays the failed screen when still connecting at 8 s, keeping the app mounted", () => {
    useModel.setState({ status: "connecting" });
    render(<BootGate>app</BootGate>);
    act(() => void vi.advanceTimersByTime(7999));
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => void vi.advanceTimersByTime(1));
    expect(screen.getByRole("alert").textContent).toContain("VITE_TIDE_TOKEN");
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByText("app")).toBeTruthy();
  });
});
