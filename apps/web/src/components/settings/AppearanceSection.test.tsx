import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { chooseOption, resetUi } from "../../testHarness.ts";
import { useSettings } from "../../state/settings.ts";
import { preferredTheme } from "../workbench/monaco/themes.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Settings › Appearance", () => {
  it("stamps the explicit theme on <html> and hands it to Monaco/xterm", () => {
    render(<AppearanceSection />);
    // dark is the product default, so it is stamped from the start
    expect(document.documentElement.dataset.theme).toBe("dark");

    chooseOption("Theme", "Light");
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(preferredTheme()).toBe("tide-light");

    chooseOption("Theme", "Dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(preferredTheme()).toBe("tide-dark");

    chooseOption("Theme", "System");
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(useSettings.getState().theme).toBe("system");
  });

  it("switches row density", () => {
    render(<AppearanceSection />);
    expect(document.documentElement.dataset.density).toBe("comfortable");
    chooseOption("Density", "Compact");
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(useSettings.getState().density).toBe("compact");
  });

  it("shows the current value on the trigger", () => {
    render(<AppearanceSection />);
    expect(screen.getByRole("combobox", { name: "Theme" }).textContent).toContain("Dark");
  });
});
