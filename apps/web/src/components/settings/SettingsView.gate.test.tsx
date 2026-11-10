import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UserSettings } from "@tide/contracts";
import { SettingsView } from "./SettingsView.tsx";
import { mockRpc, resetUi } from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { PROVIDER_FIXTURE } from "./fixtures.ts";
import { useUi } from "../../state/ui.ts";
import { defaultUserSettings, loadServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { ConfirmDialog } from "../ui/Dialog.tsx";

afterEach(() => {
  cleanup();
  resetUi();
  useServerSettings.setState({ settings: defaultUserSettings(), loaded: true, error: undefined });
});

const SERVER: UserSettings = { ...defaultUserSettings(), titleInstructions: "ticket id first" };

function open(section: Parameters<ReturnType<typeof useUi.getState>["openSettings"]>[0]): void {
  setProvidersForTest(PROVIDER_FIXTURE);
  useUi.setState({ view: "thread" });
  useUi.getState().openSettings(section);
}

describe("Settings before the server's settings load", () => {
  it("shows a quiet loading line and makes the groups inert, then the real values", async () => {
    useServerSettings.setState({ loaded: false });
    open("general");
    render(<SettingsView />);
    expect(screen.getByRole("status").textContent).toBe("Loading settings…");
    const gated = screen.getByTestId("settings-gated");
    expect(gated.hasAttribute("inert")).toBe(true);
    expect(gated.contains(screen.getByLabelText("Title instructions"))).toBe(true);
    mockRpc({ "settings.get": () => SERVER });
    await act(() => loadServerSettings());
    expect(screen.queryByTestId("settings-gated")).toBeNull();
    expect((screen.getByLabelText("Title instructions") as HTMLTextAreaElement).value).toBe("ticket id first");
  });

  it("shows a failed load with Retry, which asks again", async () => {
    useServerSettings.setState({ loaded: false });
    mockRpc({
      "settings.get": () => {
        throw new Error("unreachable");
      },
    });
    await loadServerSettings().catch(() => undefined);
    open("teams");
    render(<SettingsView />);
    expect(screen.getByRole("alert").textContent).toContain("Couldn’t load these settings: unreachable");
    const rpc = mockRpc({ "settings.get": () => SERVER });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(rpc).toHaveBeenCalledWith("settings.get", {});
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByTestId("settings-gated")).toBeNull();
  });

  it("keeps client-only sections usable while the server has not answered", () => {
    useServerSettings.setState({ loaded: false });
    for (const section of ["appearance", "notifications", "about"] as const) {
      open(section);
      const { unmount } = render(<SettingsView />);
      expect(screen.queryByTestId("settings-gated"), section).toBeNull();
      unmount();
    }
  });
});

describe("Esc in Settings", () => {
  it("leaves a text field first, dropping the uncommitted edit, and closes on the next Esc", () => {
    const rpc = mockRpc({ "settings.set": () => SERVER });
    open("general");
    render(<SettingsView />);
    const field = screen.getByLabelText("Title instructions") as HTMLTextAreaElement;
    field.focus();
    fireEvent.change(field, { target: { value: "half typed" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(document.activeElement).not.toBe(field);
    expect(field.value).toBe("");
    expect(rpc).not.toHaveBeenCalled();
    expect(useUi.getState().view).toBe("settings");
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useUi.getState().view).toBe("thread");
  });

  it("closes only a dialog open over Settings", () => {
    open("general");
    let dialogs = 1;
    const { rerender } = render(
      <>
        <SettingsView />
        <ConfirmDialog title="Delete team?" body="Gone." onConfirm={() => undefined} onCancel={() => (dialogs = 0)} />
      </>,
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(dialogs).toBe(0);
    expect(useUi.getState().view).toBe("settings");
    rerender(<SettingsView />);
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(useUi.getState().view).toBe("thread");
  });
});
