import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UserSettings, UserSettingsPatch } from "@tide/contracts";
import { mockRpc, resetUi } from "../../../testHarness.ts";
import { defaultUserSettings, patchServerSettings, useServerSettings } from "../../../state/serverSettings.ts";
import { SettingsGroup } from "./SettingsGroup.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { SettingRow } from "./SettingRow.tsx";
import { SettingText } from "./SettingText.tsx";
import { SettingToggle } from "./SettingToggle.tsx";

afterEach(() => {
  cleanup();
  resetUi();
  vi.useRealTimers();
  useServerSettings.setState({ settings: defaultUserSettings() });
});

function Worktree() {
  const on = useServerSettings((s) => s.settings.worktreeByDefault);
  return (
    <SettingsPage title="Git" blurb="Worktrees.">
      <SettingsGroup title="Worktrees">
        <SettingRow
          label="Worktree default"
          help="New threads"
          control={(id) => <SettingToggle id={id} checked={on} onChange={(v) => patchServerSettings({ worktreeByDefault: v })} />}
        />
      </SettingsGroup>
    </SettingsPage>
  );
}

describe("settings primitives", () => {
  it("renders the page header and a labelled row with an id from its label", () => {
    render(<Worktree />);
    expect(screen.getByRole("heading", { name: "Git" })).toBeDefined();
    expect(screen.getByText("Worktrees.")).toBeDefined();
    expect(screen.getByRole("region", { name: "Worktrees" })).toBeDefined();
    expect(document.getElementById("setting-worktree-default")?.textContent).toContain("New threads");
  });

  it("is a switch that Space (click) and Enter toggle, and flashes Saved once the server stores it", async () => {
    mockRpc({
      "settings.set": ((p: { patch: UserSettingsPatch }): UserSettings => ({ ...useServerSettings.getState().settings, ...p.patch }) as UserSettings) as never,
    });
    render(<Worktree />);
    const sw = screen.getByRole("switch", { name: "Worktree default" });
    expect(sw.getAttribute("aria-checked")).toBe("true");
    await act(async () => fireEvent.click(sw));
    expect(sw.getAttribute("aria-checked")).toBe("false");
    expect(await screen.findByText("Saved")).toBeDefined();
    await act(async () => fireEvent.keyDown(sw, { key: "Enter" }));
    await waitFor(() => expect(sw.getAttribute("aria-checked")).toBe("true"));
  });

  it("does not claim Saved when the server refuses", async () => {
    mockRpc({ "settings.set": () => Promise.reject(new Error("nope")) });
    render(<Worktree />);
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Worktree default" })));
    await act(async () => undefined);
    expect(screen.queryByText("Saved")).toBeNull();
    expect((screen.getByRole("switch") as HTMLInputElement).checked).toBe(true);
  });

  it("text fields normalize, validate and commit on Enter", () => {
    const commit = vi.fn();
    render(
      <SettingText
        label="Port"
        value="80"
        normalize={(t) => t.trim()}
        validate={(t) => (/^\d+$/.test(t) ? undefined : "Digits only")}
        onCommit={commit}
      />,
    );
    const input = screen.getByLabelText("Port");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("Digits only");
    expect(commit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: " 8080 " } });
    fireEvent.blur(input);
    expect(commit).toHaveBeenCalledWith("8080");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("a collapsible group starts closed", () => {
    render(
      <SettingsGroup title="Archived" collapsible>
        <SettingRow label="Old" />
      </SettingsGroup>,
    );
    expect(screen.queryByText("Old")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Archived" }));
    expect(screen.getByText("Old")).toBeDefined();
  });
});
