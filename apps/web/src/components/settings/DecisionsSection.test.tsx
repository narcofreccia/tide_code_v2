import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UserSettings } from "@tide/contracts";
import { DecisionsSection } from "./DecisionsSection.tsx";
import { mockRpc, resetUi } from "../../testHarness.ts";
import { defaultUserSettings, defaultDecisionsSettings } from "../../state/serverSettings.ts";

const EMPTY = () => ({ today: { jev: { calls: 0, tokens: 0, usd: 0 }, fallback: { calls: 0, tokens: 0, usd: 0 } }, bySite: {}, recent: [] });

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Settings › Decisions", () => {
  it("toggles the decisions model on the server", async () => {
    const rpc = mockRpc({
      "decisions.stats": EMPTY,
      "providers.list": () => [],
      "settings.set": (): UserSettings => ({ ...defaultUserSettings(), decisions: { ...defaultDecisionsSettings(), enabled: true, hasKey: false } }),
    });
    render(<DecisionsSection />);
    const toggle = screen.getByLabelText("Use Jev for decisions") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { decisions: { enabled: true } } });
    await waitFor(() => expect(toggle.checked).toBe(true));
  });

  it("posts the API key, clears the field and only ever shows `key set`", async () => {
    const rpc = mockRpc({
      "decisions.stats": EMPTY,
      "providers.list": () => [],
      "settings.set": (): UserSettings => ({ ...defaultUserSettings(), decisions: { ...defaultDecisionsSettings(), enabled: false, hasKey: true } }),
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

  it("names Jev and shows model, endpoint and price", () => {
    mockRpc({ "decisions.stats": EMPTY, "providers.list": () => [] });
    render(<DecisionsSection />);
    expect(screen.getByText("Decisions · TypeSafe Jev")).toBeDefined();
    expect(screen.getByText("jev-latest")).toBeDefined();
    expect(screen.getByText("https://api.typesafe.ai")).toBeDefined();
    expect(screen.getByText(/\$0\.042 per M input tokens/)).toBeDefined();
    expect(screen.getByText(/28K-token context/)).toBeDefined();
  });

  it("does not post an empty key", () => {
    const rpc = mockRpc({ "decisions.stats": EMPTY, "providers.list": () => [] });
    render(<DecisionsSection />);
    expect((screen.getByText("Save key") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.submit(screen.getByLabelText("Decisions API key").closest("form") as HTMLFormElement);
    expect(rpc).not.toHaveBeenCalledWith("settings.set", expect.anything());
  });
});
