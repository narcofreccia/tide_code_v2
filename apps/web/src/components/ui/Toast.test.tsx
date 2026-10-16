import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ToastHost } from "./Toast.tsx";
import { ACTION_DISMISS_MS, showToast, useToasts } from "../../state/toast.ts";

afterEach(() => {
  cleanup();
  useToasts.setState({ toasts: [] });
  vi.useRealTimers();
});

describe("toasts", () => {
  it("dismisses a plain toast after 3 s", () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => showToast("Copied"));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.queryByText("Copied")).toBeNull();
  });

  it("keeps a toast with an action up for 6 s", () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => showToast("Archived", { label: "Undo", onClick: () => undefined }));
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByText("Archived")).toBeDefined();
    act(() => vi.advanceTimersByTime(ACTION_DISMISS_MS - 3000));
    expect(screen.queryByText("Archived")).toBeNull();
  });

  it("runs the action once and closes the toast", () => {
    const onClick = vi.fn();
    render(<ToastHost />);
    act(() => showToast("Archived", { label: "Undo", onClick }));
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Archived")).toBeNull();
  });
});
