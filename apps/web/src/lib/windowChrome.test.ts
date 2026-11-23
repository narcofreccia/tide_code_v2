import { afterEach, describe, expect, it, vi } from "vitest";
import { applyScrollbarFlag, desktopPlatform, sendWindowAction, windowActionUrl } from "./windowChrome.ts";

afterEach(() => {
  delete document.documentElement.dataset.desktop;
  delete document.documentElement.dataset.scrollbars;
});

describe("windowActionUrl", () => {
  it("derives the shell origin from the app origin on Windows (WebView2)", () => {
    expect(windowActionUrl("close", { protocol: "http:", href: "http://tauri.localhost/#/mission" })).toBe(
      "http://tide-shell.localhost/window/close",
    );
    expect(windowActionUrl("minimize", { protocol: "https:", href: "https://tauri.localhost/" })).toBe(
      "https://tide-shell.localhost/window/minimize",
    );
  });

  it("uses the scheme itself where the app is on tauri://", () => {
    expect(windowActionUrl("toggle-maximize", { protocol: "tauri:", href: "tauri://localhost/" })).toBe(
      "tide-shell://localhost/window/toggle-maximize",
    );
  });

  it("falls back to WebView2's shell origin off the app origin (vite dev in the shell)", () => {
    expect(windowActionUrl("close", { protocol: "http:", href: "http://localhost:5173/" })).toBe("http://tide-shell.localhost/window/close");
  });
});

describe("sendWindowAction", () => {
  const app = { protocol: "http:", href: "http://tauri.localhost/" };

  it("posts no-cors and does not wait for an answer", () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null)));
    sendWindowAction("toggle-maximize", app, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledWith("http://tide-shell.localhost/window/toggle-maximize", expect.objectContaining({ method: "POST", mode: "no-cors" }));
  });

  it("swallows sync and async failures", async () => {
    const rejected = vi.fn(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(() => sendWindowAction("close", app, rejected)).not.toThrow();
    await Promise.resolve();
    const throwing = vi.fn((): Promise<Response> => {
      throw new TypeError("refused");
    });
    expect(() => sendWindowAction("close", app, throwing)).not.toThrow();
  });
});

describe("desktopPlatform", () => {
  it("reads the flag applyDesktopFlag stamped, ignoring anything else", () => {
    expect(desktopPlatform()).toBeNull();
    document.documentElement.dataset.desktop = "win";
    expect(desktopPlatform()).toBe("win");
    document.documentElement.dataset.desktop = "amiga";
    expect(desktopPlatform()).toBeNull();
  });
});

describe("applyScrollbarFlag", () => {
  it("marks classic (space-taking) scrollbars only", () => {
    expect(applyScrollbarFlag(17)).toBe(true);
    expect(document.documentElement.dataset.scrollbars).toBe("classic");
    expect(applyScrollbarFlag(0)).toBe(false);
    expect(document.documentElement.dataset.scrollbars).toBeUndefined();
  });

  it("measures 0 where layout is not computed (overlay, jsdom)", () => {
    expect(applyScrollbarFlag()).toBe(false);
  });
});
