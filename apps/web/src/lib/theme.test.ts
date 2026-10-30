import { afterEach, describe, expect, it } from "vitest";
import { applyCustomTheme, applyFonts, safeFamily } from "./theme.ts";

const html = () => document.documentElement;

afterEach(() => {
  applyCustomTheme(undefined);
  applyFonts({ size: 13 });
});

describe("theme application", () => {
  it("sets custom tokens on <html> and removes them on clear", () => {
    applyCustomTheme({ name: "x", scheme: "light", tokens: { "--bg": "#fff", "--accent": "#123456" } });
    expect(html().style.getPropertyValue("--bg")).toBe("#fff");
    expect(html().style.getPropertyValue("--accent")).toBe("#123456");
    expect(html().style.getPropertyValue("color-scheme")).toBe("light");
    applyCustomTheme(undefined);
    expect(html().style.getPropertyValue("--bg")).toBe("");
    expect(html().style.getPropertyValue("color-scheme")).toBe("");
  });

  it("applies and clears font families and size", () => {
    applyFonts({ ui: "Georgia, serif", mono: "Menlo, monospace", size: 15 });
    expect(html().style.getPropertyValue("--font")).toBe("Georgia, serif");
    expect(html().style.getPropertyValue("--font-mono")).toBe("Menlo, monospace");
    expect(html().style.getPropertyValue("--font-size-base")).toBe("15px");
    applyFonts({ size: 13 });
    expect(html().style.getPropertyValue("--font")).toBe("");
    expect(html().style.getPropertyValue("--font-size-base")).toBe("");
  });

  it("refuses family strings that could break out of the declaration", () => {
    expect(safeFamily("a; color: red")).toBeUndefined();
    expect(safeFamily('"Fira Code", monospace')).toBe('"Fira Code", monospace');
  });
});
