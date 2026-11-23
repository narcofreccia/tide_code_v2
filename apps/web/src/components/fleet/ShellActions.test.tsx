import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ShellActions } from "./ShellActions.tsx";

const at = (href: string) => ({ protocol: new URL(href).protocol, href });

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe("ShellActions", () => {
  it("renders nothing on a browser origin", () => {
    const navigate = vi.fn();
    const { container } = render(<ShellActions location={at("http://192.168.1.20:3777/?remote=1")} navigate={navigate} />);
    expect(container.textContent).toBe("");
    // the default location is jsdom's http://localhost page
    render(<ShellActions />);
    expect(screen.queryByText("Connect to another machine")).toBeNull();
  });

  it("offers pairing in the local shell and opens the splash with its form", () => {
    document.documentElement.dataset.theme = "light";
    const navigate = vi.fn();
    render(<ShellActions location={at("tauri://localhost/#/settings")} navigate={navigate} />);
    expect(screen.queryByText("Run the local server")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    expect(navigate).toHaveBeenCalledWith("tide-shell://localhost/?theme=light&connect=1");
  });

  it("offers going back to the local server when the shell shows another machine (Windows)", () => {
    const navigate = vi.fn();
    render(<ShellActions location={at("http://tauri.localhost/?remote=1#/settings")} navigate={navigate} />);
    fireEvent.click(screen.getByRole("button", { name: "Run locally" }));
    expect(navigate).toHaveBeenCalledWith("http://tide-shell.localhost/?theme=system&local=1");
    fireEvent.click(screen.getByRole("button", { name: "Connect…" }));
    expect(navigate).toHaveBeenLastCalledWith("http://tide-shell.localhost/?theme=system&connect=1");
  });
});
