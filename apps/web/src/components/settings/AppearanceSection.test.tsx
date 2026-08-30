import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { AppearanceSection } from "./AppearanceSection.tsx";
import { resetUi } from "../../testHarness.ts";
import { useSettings } from "../../state/settings.ts";
import { preferredTheme } from "../workbench/monaco/themes.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Settings › Appearance", () => {
  it("stamps the explicit theme on <html> and hands it to Monaco/xterm", () => {
    render(<AppearanceSection />);
    expect(document.documentElement.dataset.theme).toBeUndefined();

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "light" } });
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(preferredTheme()).toBe("tide-light");

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "dark" } });
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(preferredTheme()).toBe("tide-dark");

    fireEvent.change(screen.getByLabelText("Theme"), { target: { value: "system" } });
    expect(document.documentElement.dataset.theme).toBeUndefined();
    expect(useSettings.getState().theme).toBe("system");
  });

  it("switches row density", () => {
    render(<AppearanceSection />);
    expect(document.documentElement.dataset.density).toBe("comfortable");
    fireEvent.change(screen.getByLabelText("Density"), { target: { value: "compact" } });
    expect(document.documentElement.dataset.density).toBe("compact");
    expect(useSettings.getState().density).toBe("compact");
  });
});
