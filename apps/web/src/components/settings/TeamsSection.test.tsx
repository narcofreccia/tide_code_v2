import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Team } from "@tide/contracts";
import { TeamsSection } from "./TeamsSection.tsx";
import { attachFakeStore, chooseOption, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { setProvidersForTest } from "../../state/providers.ts";

afterEach(() => {
  cleanup();
  resetUi();
  useServerSettings.setState((s) => ({ settings: { ...s.settings, teams: [] } }));
});

const duo: Team = {
  id: "duo",
  name: "Duo",
  stages: [
    { key: "builder", role: "builder", provider: "claude", worktree: "own" },
    { key: "checker", role: "checker", provider: "codex", worktree: "inherit", inheritFrom: "builder" },
  ],
};

function setup(teams: Team[] = [duo]) {
  useServerSettings.setState((s) => ({ settings: { ...s.settings, teams } }));
  attachFakeStore(modelWith({}));
  setProvidersForTest([]);
  const rpc = mockRpc({
    "providers.list": () => [],
    "settings.set": (params: { patch: { teams?: Team[] } }) => ({
      ...useServerSettings.getState().settings,
      teams: params.patch.teams ?? [],
    }),
  });
  render(<TeamsSection />);
  return rpc;
}

describe("Settings › Teams", () => {
  it("lists teams with their stages", () => {
    setup();
    expect(screen.getByText("Duo")).toBeDefined();
    expect(screen.getByText("builder (Claude Code)")).toBeDefined();
    expect(screen.getByText(/checker \(Codex\)/)).toBeDefined();
  });

  it("resets to presets by saving an empty list", async () => {
    const rpc = setup();
    fireEvent.click(screen.getByText("Reset to presets"));
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { teams: [] } }));
  });

  it("edits a team and saves the whole list", async () => {
    const rpc = setup();
    fireEvent.click(screen.getByText("Edit"));
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "Duo 2" } });
    fireEvent.change(screen.getByLabelText("Stage 2 role"), { target: { value: "Code Checker" } });
    chooseOption("Stage 2 worktree", "Own worktree");
    fireEvent.click(screen.getByText("Add stage"));
    fireEvent.change(screen.getByLabelText("Stage 3 role"), { target: { value: "tester" } });
    chooseOption("Stage 3 worktree", "Inherit a checkout");
    chooseOption("Stage 3 inherits from", /1\. builder/);
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Save"));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("settings.set", expect.anything()));
    const [, params] = rpc.mock.calls.find(([m]) => m === "settings.set") as [string, { patch: { teams: Team[] } }];
    const saved = params.patch.teams[0];
    expect(saved?.name).toBe("Duo 2");
    expect(saved?.id).toBe("duo");
    expect(saved?.stages.map((s) => s.key)).toEqual(["builder", "code-checker", "tester"]);
    expect(saved?.stages[1]).toMatchObject({ worktree: "own" });
    expect(saved?.stages[2]).toMatchObject({ worktree: "inherit", inheritFrom: "builder" });
  });

  it("refuses a team without a role", () => {
    setup([]);
    fireEvent.click(screen.getByText("New team"));
    fireEvent.change(screen.getByLabelText("Team name"), { target: { value: "X" } });
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Save"));
    expect(screen.getByRole("alert").textContent).toContain("role");
  });

  it("duplicates and deletes", async () => {
    const rpc = setup();
    fireEvent.click(screen.getByText("Duplicate"));
    await waitFor(() => expect(rpc).toHaveBeenCalledTimes(1));
    const first = rpc.mock.calls[0] as [string, { patch: { teams: Team[] } }];
    expect(first[1].patch.teams.map((t) => t.name)).toEqual(["Duo", "Duo copy"]);
  });
});
