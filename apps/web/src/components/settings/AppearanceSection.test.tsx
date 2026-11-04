import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

describe("Settings › Appearance › rail grouping", () => {
  it("toggles grouping the rail by project", () => {
    render(<AppearanceSection />);
    const toggle = screen.getByRole("switch", { name: "Group rail by project" });
    expect(useSettings.getState().railGroupBy).toBe("status");
    fireEvent.click(toggle);
    expect(useSettings.getState().railGroupBy).toBe("project");
    fireEvent.click(toggle);
    expect(useSettings.getState().railGroupBy).toBe("status");
  });
});

describe("Settings › Appearance › custom theme and fonts", () => {
  it("imports a VS Code theme, previews it, applies and clears it", async () => {
    render(<AppearanceSection />);
    const input = screen.getByLabelText("VS Code theme file") as HTMLInputElement;
    const file = new File([JSON.stringify({ name: "Mine", type: "dark", colors: { "editor.background": "#101820", "button.background": "#ff8800" } })], "mine.json", { type: "application/json" });
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByRole("img", { name: "Preview of Mine" });
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("#101820");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#ff8800");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(document.documentElement.style.getPropertyValue("--bg")).toBe("");
    expect(useSettings.getState().customTheme).toBeUndefined();
  });

  it("shows an error for a file that is not a theme", async () => {
    render(<AppearanceSection />);
    const input = screen.getByLabelText("VS Code theme file") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [new File(["{}"], "x.json")] } });
    expect((await screen.findByRole("alert")).textContent).toMatch(/colors/);
  });

  it("changes the base size and mono family", () => {
    render(<AppearanceSection />);
    chooseOption("Base size", "15px");
    expect(document.documentElement.style.getPropertyValue("--font-size-base")).toBe("15px");
    chooseOption("Mono font", "Consolas");
    expect(document.documentElement.style.getPropertyValue("--font-mono")).toContain("Consolas");
    chooseOption("Mono font", "System mono");
    expect(document.documentElement.style.getPropertyValue("--font-mono")).toBe("");
  });
});
