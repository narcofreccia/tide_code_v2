import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WindowControls, WindowStrip } from "./WindowControls.tsx";

const fetchMock = vi.fn((_url: string, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 200 })));

beforeEach(() => {
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.desktop;
});

describe("WindowControls", () => {
  it("renders nothing in a plain browser and requests nothing", () => {
    const { container } = render(<WindowControls />);
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("button")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["mac", "linux"])("renders nothing on the %s shell (native controls)", (platform) => {
    document.documentElement.dataset.desktop = platform;
    const { container } = render(<WindowControls />);
    expect(container.innerHTML).toBe("");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on Windows shows minimise, maximise and close, close rightmost, outside any drag region", () => {
    document.documentElement.dataset.desktop = "win";
    render(<WindowControls />);
    const group = screen.getByRole("group", { name: "Window" });
    const labels = Array.from(group.querySelectorAll("button")).map((b) => b.getAttribute("aria-label"));
    expect(labels).toEqual(["Minimize", "Maximize or restore", "Close"]);
    expect(group.closest("[data-tauri-drag-region]")).toBeNull();
    for (const b of group.querySelectorAll("button")) expect(b.hasAttribute("data-tauri-drag-region")).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Minimize", "minimize"],
    ["Maximize or restore", "toggle-maximize"],
    ["Close", "close"],
  ])("%s posts /window/%s to the shell origin, fire and forget", (label, action) => {
    document.documentElement.dataset.desktop = "win";
    render(<WindowControls />);
    fireEvent.click(screen.getByRole("button", { name: label }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    // jsdom is not on the app origin, so the WebView2 shell origin is the fallback
    expect(url).toBe(`http://tide-shell.localhost/window/${action}`);
    expect(init).toMatchObject({ method: "POST", mode: "no-cors" });
  });

  it("a failing request never throws into React", async () => {
    document.documentElement.dataset.desktop = "win";
    fetchMock.mockImplementationOnce(() => Promise.reject(new TypeError("Failed to fetch")));
    render(<WindowControls />);
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Close" }))).not.toThrow();
    await Promise.resolve();
    vi.stubGlobal("fetch", () => {
      throw new TypeError("blocked");
    });
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Minimize" }))).not.toThrow();
  });
});

describe("WindowStrip", () => {
  it("is a drag strip holding the buttons on Windows only", () => {
    const { container, rerender } = render(<WindowStrip />);
    expect(container.innerHTML).toBe("");
    document.documentElement.dataset.desktop = "win";
    rerender(<WindowStrip key="win" />);
    const strip = container.firstElementChild as HTMLElement;
    expect(strip.hasAttribute("data-tauri-drag-region")).toBe(true);
    expect(screen.getByRole("button", { name: "Close" })).toBeDefined();
  });
});
