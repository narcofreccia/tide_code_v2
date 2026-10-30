import { describe, expect, it } from "vitest";
import { DEFAULT_DARK_TOKENS } from "./theme.ts";
import { blend, colorToHex, importVscodeTheme, parseJsonc } from "./vscodeTheme.ts";

describe("vscodeTheme", () => {
  it("blends and converts colours", () => {
    expect(blend("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(blend("#ff0000", "#0000ff", 0)).toBe("#0000ff");
    expect(colorToHex("rgba(91, 157, 255, 0.16)")).toBe("#5b9dff");
    expect(colorToHex("#abc")).toBe("#aabbcc");
  });

  it("reads JSONC with comments and trailing commas", () => {
    expect(parseJsonc('{ // c\n "a": "x//y", /* b */ "b": [1,], }')).toEqual({ a: "x//y", b: [1] });
  });

  it("maps the VS Code colours onto tokens and derives soft variants", () => {
    const theme = importVscodeTheme(
      JSON.stringify({
        name: "Mine",
        type: "light",
        colors: {
          "editor.background": "#ffffff",
          "sideBar.background": "#f3f3f3",
          "editorWidget.background": "#eeeeee",
          "menu.background": "#fafafa",
          "panel.border": "#dddddd",
          focusBorder: "#0090f1",
          "editor.foreground": "#222222",
          descriptionForeground: "#717171",
          "button.background": "#007acc",
          "button.foreground": "#ffffff",
          errorForeground: "#cc0000",
          "terminal.ansiGreen": "#00aa00",
          "terminal.ansiYellow": "#bbaa00",
        },
      }),
      DEFAULT_DARK_TOKENS,
    );
    const t = theme.tokens;
    expect(theme.name).toBe("Mine");
    expect(theme.scheme).toBe("light");
    expect(t["--bg"]).toBe("#ffffff");
    expect(t["--surface"]).toBe("#f3f3f3");
    expect(t["--surface-raised"]).toBe("#fafafa");
    expect(t["--text"]).toBe("#222222");
    expect(t["--text-2"]).toBe("#717171");
    expect(t["--muted"]).toBe("#717171");
    expect(t["--accent"]).toBe("#007acc");
    expect(t["--st-running"]).toBe("#007acc");
    expect(t["--st-error"]).toBe("#cc0000");
    expect(t["--accent-soft"]).toBe(blend("#007acc", "#ffffff", 0.16));
    expect(t["--st-ok-soft"]).toBe(blend("#00aa00", "#ffffff", 0.16));
  });

  it("falls back to the current tokens for missing keys and infers the scheme", () => {
    const theme = importVscodeTheme({ colors: { "editor.background": "#101010" } }, DEFAULT_DARK_TOKENS, "file");
    expect(theme.name).toBe("file");
    expect(theme.scheme).toBe("dark");
    expect(theme.tokens["--accent"]).toBe(DEFAULT_DARK_TOKENS["--accent"]);
    expect(theme.tokens["--st-limited"]).toBe(DEFAULT_DARK_TOKENS["--st-limited"]);
  });

  it("rejects things that are not themes", () => {
    expect(() => importVscodeTheme("nope", {})).toThrow("Not valid JSON");
    expect(() => importVscodeTheme("{}", {})).toThrow(/colors/);
  });
});
