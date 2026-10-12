import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UserSettings } from "@tide/contracts";
import { DecisionsSection } from "./DecisionsSection.tsx";
import { mockRpc, resetUi } from "../../testHarness.ts";
import { defaultUserSettings } from "../../state/serverSettings.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Settings › Decisions", () => {
  it("toggles the decisions model on the server", async () => {
    const rpc = mockRpc({
      "settings.set": (): UserSettings => ({ ...defaultUserSettings(), decisions: { enabled: true, hasKey: false } }),
    });
    render(<DecisionsSection />);
    const toggle = screen.getByLabelText("Triage the Inbox with the decisions model") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { decisions: { enabled: true } } });
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it("posts the API key, clears the field and only ever shows `key set`", async () => {
    const rpc = mockRpc({
      "settings.set": (): UserSettings => ({ ...defaultUserSettings(), decisions: { enabled: false, hasKey: true } }),
    });
    render(<DecisionsSection />);
    expect(screen.getByText("no key")).toBeDefined();
    const field = screen.getByLabelText("Decisions API key") as HTMLInputElement;
    expect(field.type).toBe("password");
    fireEvent.change(field, { target: { value: "sk-secret" } });
    fireEvent.click(screen.getByText("Save key"));

    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { decisions: { apiKey: "sk-secret" } } });
    expect(field.value).toBe("");
    expect(await screen.findByText("key set")).toBeDefined();
    expect(document.body.textContent).not.toContain("sk-secret");
  });

  it("does not post an empty key", () => {
    const rpc = mockRpc({});
    render(<DecisionsSection />);
    expect((screen.getByText("Save key") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText("Decisions API key").closest("form") as HTMLFormElement);
    expect(rpc).not.toHaveBeenCalled();
  });
});
