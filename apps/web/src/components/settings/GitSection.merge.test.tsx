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
      settings: { ...defaultUserSettings(), git: { mergeStrategy: "rebase", deleteBranchOnMerge: false, confirmMergeBack: true, pushThreadBranches: "never", syncBaseWithRemote: true, generateMessages: true } },
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
    expect(useServerSettings.getState().settings.git).toEqual({ mergeStrategy: "merge", deleteBranchOnMerge: false, confirmMergeBack: false, pushThreadBranches: "never", syncBaseWithRemote: true, generateMessages: true });
    expect(screen.getByText("Saved")).toBeDefined();
  });
});

describe("Settings › Git remote and messages (R17)", () => {
  it("patches pushThreadBranches, syncBaseWithRemote and generateMessages", async () => {
    const rpc = serve();
    render(<GitSection />);
    expect(screen.getByText("Thread branches stay on this machine until you publish")).toBeDefined();
    chooseOption("Push thread branches to origin", /After every turn/);
    await act(async () => undefined);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { git: { pushThreadBranches: "on-checkpoint" } } });
    expect(screen.getByText("Push the committed branch after each turn, for review elsewhere")).toBeDefined();
    const sync = screen.getByRole("switch", { name: "Sync the base branch with origin" }) as HTMLInputElement;
    expect(sync.checked).toBe(true);
    await act(async () => fireEvent.click(sync));
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { git: { syncBaseWithRemote: false } } });
    await act(async () => fireEvent.click(screen.getByRole("switch", { name: "Generate commit and PR messages" })));
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { git: { generateMessages: false } } });
    expect(useServerSettings.getState().settings.git).toMatchObject({ pushThreadBranches: "on-checkpoint", syncBaseWithRemote: false, generateMessages: false });
  });
});
