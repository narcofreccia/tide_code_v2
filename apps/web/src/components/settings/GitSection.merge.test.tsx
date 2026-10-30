import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UserSettings, UserSettingsPatch } from "@tide/contracts";
import { GitSection } from "./GitSection.tsx";
import { attachFakeStore, chooseOption, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { defaultUserSettings, useServerSettings } from "../../state/serverSettings.ts";

afterEach(() => {
  cleanup();
  resetUi();
  useServerSettings.setState({ settings: defaultUserSettings() });
});

function serve() {
  attachFakeStore(modelWith({}));
  return mockRpc({
    "server.info": () => ({ version: "0.0.0", environmentId: "env-1" }),
    "settings.set": ((p: { patch: UserSettingsPatch }): UserSettings => {
      const base = useServerSettings.getState().settings;
      return { ...base, git: { ...base.git, ...p.patch.git } };
    }) as never,
  });
}

describe("Settings › Git merge-back defaults", () => {
  it("shows the server's values", () => {
    serve();
    useServerSettings.setState({
      settings: { ...defaultUserSettings(), git: { mergeStrategy: "rebase", deleteBranchOnMerge: false, confirmMergeBack: true } },
    });
    render(<GitSection />);
    expect(screen.getByRole("combobox", { name: "Merge back strategy" }).textContent).toContain("Rebase");
    expect(screen.getByText(/without a pull request/)).toBeDefined();
    expect((screen.getByRole("switch", { name: "Delete the branch after merging" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("switch", { name: "Ask before merging back from the inbox" }) as HTMLInputElement).checked).toBe(true);
  });

  it("patches { git } for the strategy and both toggles", async () => {
    const rpc = serve();
    render(<GitSection />);
    chooseOption("Merge back strategy", "Merge commit");
    await act(async () => undefined);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { git: { mergeStrategy: "merge" } } });
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Delete the branch after merging" })));
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { git: { deleteBranchOnMerge: false } } });
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Ask before merging back from the inbox" })));
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { git: { confirmMergeBack: false } } });
    expect(useServerSettings.getState().settings.git).toEqual({ mergeStrategy: "merge", deleteBranchOnMerge: false, confirmMergeBack: false });
    expect(screen.getByText("Saved")).toBeDefined();
  });
});
