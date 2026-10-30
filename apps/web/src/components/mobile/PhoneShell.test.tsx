import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../../App.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { resetMobileNav } from "./mobileNav.ts";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: () => undefined, removeEventListener: () => undefined })),
  );
});
afterEach(() => {
  cleanup();
  resetUi();
  resetMobileNav();
  vi.unstubAllGlobals();
});

describe("phone shell", () => {
  it("lands on the Inbox with bottom tabs and no rail", () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
    render(<App />);
    expect(screen.getByRole("navigation", { name: "Primary" })).toBeDefined();
    expect(screen.getByLabelText("Inbox")).toBeDefined();
    expect(screen.queryByRole("navigation", { name: "Navigation" })).toBeNull();
  });

  it("routes with the tabs", () => {
    attachFakeStore(modelWith({}));
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
    expect(useUi.getState().view).toBe("settings");
    fireEvent.click(screen.getByRole("button", { name: /Mission/ }));
    expect(useUi.getState().view).toBe("mission");
    expect(screen.queryByLabelText("Inbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Inbox/ }));
    expect(screen.getByLabelText("Inbox")).toBeDefined();
  });

  it("shows a thread full-width with Back and Code, hiding the tabs", () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
    useUi.getState().selectThread("t1");
    render(<App />);
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    expect(screen.getByRole("button", { name: "Code" })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
    expect(useUi.getState().selectedThreadId).toBeNull();
    expect(screen.getByLabelText("Inbox")).toBeDefined();
  });
});
