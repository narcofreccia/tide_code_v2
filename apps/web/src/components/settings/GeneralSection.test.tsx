import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UserSettings } from "@tide/contracts";
import { GeneralSection } from "./GeneralSection.tsx";
import { chooseOption, mockRpc, resetUi } from "../../testHarness.ts";
import { defaultUserSettings, useServerSettings } from "../../state/serverSettings.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function serve() {
  return mockRpc({
    "settings.set": (p: { patch: Partial<UserSettings> }) => ({ ...defaultUserSettings(), ...p.patch }),
  });
}

describe("General settings", () => {
  it("saves the follow-up default on the server", async () => {
    const rpc = serve();
    render(<GeneralSection />);
    chooseOption("Follow-up default", "Queue");
    await act(async () => undefined);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { followUpMode: "queue" } });
    expect(useServerSettings.getState().settings.followUpMode).toBe("queue");
    expect(localStorage.getItem("tide.followUpMode")).toBeNull();
  });

  it("saves the usage-limit policy on the server", async () => {
    const rpc = serve();
    render(<GeneralSection />);
    chooseOption("Usage limit policy", "Resume at reset");
    await act(async () => undefined);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { limitPolicy: "reset" } });
    expect(localStorage.getItem("tide.limitPolicy")).toBeNull();
  });

  it("binds Continue threads after a restart", async () => {
    const rpc = serve();
    render(<GeneralSection />);
    const box = screen.getByRole("switch", { name: "Continue threads after a restart" }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    await act(async () => fireEvent.click(box));
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { continueAfterRestart: true } });
    expect(box.checked).toBe(true);
  });

  it("shows the values the server holds", () => {
    useServerSettings.setState({ settings: { ...defaultUserSettings(), followUpMode: "queue", limitPolicy: "reset" } });
    render(<GeneralSection />);
    expect(screen.getByRole("combobox", { name: "Follow-up default" }).textContent).toContain("Queue");
    expect(screen.getByRole("combobox", { name: "Usage limit policy" }).textContent).toContain("Resume at reset");
    expect(screen.getByText(/handoffs are lossy/)).toBeDefined();
  });

  it("saves the title instructions on blur, trimmed, and clears them with null", async () => {
    const rpc = serve();
    render(<GeneralSection />);
    const field = screen.getByLabelText("Title instructions") as HTMLTextAreaElement;
    expect(field.value).toBe("");
    fireEvent.change(field, { target: { value: "  start with the ticket id\nmax 5 words " } });
    fireEvent.blur(field);
    await act(async () => undefined);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { titleInstructions: "start with the ticket id\nmax 5 words" } });
    expect(useServerSettings.getState().settings.titleInstructions).toBe("start with the ticket id\nmax 5 words");
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.blur(field);
    await act(async () => undefined);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { titleInstructions: null } });
  });
});
