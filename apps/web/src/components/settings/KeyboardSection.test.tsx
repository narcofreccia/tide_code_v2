import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { KeyboardSection } from "./KeyboardSection.tsx";
import { resetUi } from "../../testHarness.ts";
import { setRpcCaller } from "../../state/model.ts";
import { useServerSettings } from "../../state/serverSettings.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function row(id: string): HTMLElement {
  return document.querySelector(`tr[data-shortcut="${id}"]`) as HTMLElement;
}

function mockSettingsSet(): Array<Record<string, string>> {
  const sent: Array<Record<string, string>> = [];
  setRpcCaller((async (method: string, params: { patch?: { keybindings?: Record<string, string> } }) => {
    if (method !== "settings.set") throw new Error(method);
    sent.push(params.patch?.keybindings ?? {});
    return { ...useServerSettings.getState().settings };
  }) as never);
  return sent;
}

describe("Settings › Keyboard rebinding", () => {
  it("marks surface-owned entries fixed and others rebindable", () => {
    render(<KeyboardSection />);
    for (const id of ["send", "stop", "approve", "deny", "save", "prev-turn", "next-turn"]) {
      expect(within(row(id)).getByText("fixed")).toBeTruthy();
      expect(within(row(id)).queryByRole("button", { name: /Rebind/ })).toBeNull();
    }
    expect(within(row("palette")).getByRole("button", { name: "Rebind Command palette" })).toBeTruthy();
  });

  it("captures the next chord and saves the whole map", async () => {
    const sent = mockSettingsSet();
    render(<KeyboardSection />);
    fireEvent.click(within(row("palette")).getByRole("button", { name: /Rebind/ }));
    expect(within(row("palette")).getByText("Press keys…")).toBeTruthy();
    fireEvent.keyDown(document.body, { key: "J", metaKey: true, shiftKey: true });
    await waitFor(() => expect(sent).toEqual([{ palette: "mod+shift+j" }]));
    expect(useServerSettings.getState().settings.keybindings["palette"]).toBe("mod+shift+j");
  });

  it("Esc cancels and Backspace resets", async () => {
    const sent = mockSettingsSet();
    useServerSettings.setState({ settings: { ...useServerSettings.getState().settings, keybindings: { palette: "mod+j" } } });
    render(<KeyboardSection />);
    fireEvent.click(within(row("palette")).getByRole("button", { name: /Rebind/ }));
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(within(row("palette")).queryByText("Press keys…")).toBeNull();
    expect(sent).toEqual([]);
    fireEvent.click(within(row("palette")).getByRole("button", { name: /Rebind/ }));
    fireEvent.keyDown(document.body, { key: "Backspace" });
    await waitFor(() => expect(sent).toEqual([{ palette: "" }]));
  });

  it("shows a conflict in red when a chord is shared in an overlapping scope", () => {
    useServerSettings.setState({ settings: { ...useServerSettings.getState().settings, keybindings: { mission: "mod+k" } } });
    render(<KeyboardSection />);
    expect(within(row("palette")).getByRole("alert").textContent).toContain("Mission Control");
    expect(within(row("mission")).getByRole("alert").textContent).toContain("Command palette");
    // the shipped ⌘⇧E pair is deliberate and stays quiet
    expect(within(row("effort")).queryByRole("alert")).toBeNull();
  });

  it("Reset all clears every override", async () => {
    const sent = mockSettingsSet();
    useServerSettings.setState({ settings: { ...useServerSettings.getState().settings, keybindings: { palette: "mod+j", rail: "mod+m" } } });
    render(<KeyboardSection />);
    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    await waitFor(() => expect(sent).toEqual([{ palette: "", rail: "" }]));
  });
});
