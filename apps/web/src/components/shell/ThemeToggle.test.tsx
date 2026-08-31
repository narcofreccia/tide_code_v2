import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThemeToggle } from "./ThemeToggle.tsx";
import { resetUi } from "../../testHarness.ts";
import { effectiveTheme, toggleTheme, useSettings } from "../../state/settings.ts";
import { handleShortcut, SHORTCUTS } from "../../lib/shortcuts.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("theme", () => {
  it("defaults to dark and stamps it on <html>", () => {
    expect(useSettings.getState().theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("toggleTheme flips, and from system it resolves what is on screen first", () => {
    expect(toggleTheme()).toBe("light");
    expect(useSettings.getState().theme).toBe("light");
    expect(toggleTheme()).toBe("dark");

    useSettings.getState().setTheme("system");
    // jsdom reports no light preference, so `system` resolves to dark
    expect(effectiveTheme()).toBe("dark");
    expect(toggleTheme()).toBe("light");
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("the button flips the theme and shows the matching glyph", () => {
    render(<ThemeToggle />);
    const button = screen.getByRole("button", { name: /Toggle light\/dark/ });
    expect(button.textContent).toBe("☾");
    fireEvent.click(button);
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(button.textContent).toBe("☀");
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });

  it("follows a theme change made elsewhere", () => {
    render(<ThemeToggle />);
    act(() => useSettings.getState().setTheme("light"));
    expect(screen.getByRole("button", { name: /Toggle light\/dark/ }).textContent).toBe("☀");
  });

  it("is bound to ⌘⇧L in the shortcut registry", () => {
    const entry = SHORTCUTS.find((s) => s.id === "theme");
    expect(entry?.keys).toBe("⌘⇧L");
    expect(handleShortcut(new KeyboardEvent("keydown", { key: "l", metaKey: true, shiftKey: true }))).toBe(true);
    expect(useSettings.getState().theme).toBe("light");
  });
});
