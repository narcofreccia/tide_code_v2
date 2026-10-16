import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Team } from "@tide/contracts";
import { NewThreadDialogHost } from "./NewThreadPopover.tsx";
import { attachFakeStore, chooseOption, makeThread, modelWith, optionLabels, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { useServerSettings } from "../../state/serverSettings.ts";

afterEach(() => {
  cleanup();
  resetUi();
  useServerSettings.setState((s) => ({ settings: { ...s.settings, teams: [], worktreeByDefault: true } }));
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };
const ship: Team = {
  id: "ship",
  name: "Ship",
  stages: [
    { key: "planner", role: "planner", provider: "claude", worktree: "own" },
    { key: "implementer", role: "implementer", provider: "codex", worktree: "own" },
    { key: "reviewer", role: "reviewer", provider: "opencode", worktree: "inherit", inheritFrom: "implementer" },
  ],
};
const solo: Team = { id: "solo", name: "Solo", stages: [{ key: "dev", role: "dev", provider: "pi", worktree: "own" }] };

function open(tab?: "team") {
  useServerSettings.setState((s) => ({ settings: { ...s.settings, teams: [ship, solo] } }));
  const fake = attachFakeStore(modelWith({ projects: { p1: project }, threads: { t1: makeThread("t1") } }));
  render(<NewThreadDialogHost />);
  act(() => useUi.getState().openNewThread({ projectId: "p1", ...(tab ? { tab } : {}) }));
  return fake;
}

describe("new thread form › Team tab", () => {
  it("switches to Team and previews the stages", () => {
    open();
    fireEvent.click(screen.getByRole("radio", { name: "Team" }));
    expect(optionLabels("Team")[0]).toBe("Ship — planner (Claude Code) → implementer (Codex) → reviewer (OpenCode)");
    expect(screen.getByText("runs in implementer's checkout")).toBeDefined();
  });

  it("Edit stages… closes the dialog and opens Settings on Teams", () => {
    open("team");
    fireEvent.click(screen.getByRole("button", { name: "Edit stages…" }));
    const ui = useUi.getState();
    expect(ui.newThreadProjectId).toBeNull();
    expect(ui.settingsSection).toBe("teams");
    expect(ui.view).toBe("settings");
  });

  it("requires a task, then dispatches team.run with the chosen team", async () => {
    const fake = open("team");
    const start = screen.getByText("Start team run") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    chooseOption("Team", /^Solo/);
    fireEvent.change(screen.getByLabelText("Task"), { target: { value: " fix login " } });
    fireEvent.change(screen.getByLabelText("Run title"), { target: { value: "Login" } });
    fireEvent.click(screen.getByLabelText("Use a worktree for the lead"));
    fireEvent.click(screen.getByText("Start team run"));
    await waitFor(() => expect(fake.dispatch).toHaveBeenCalled());
    expect(fake.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "team.run",
      projectId: "p1",
      team: solo,
      task: "fix login",
      title: "Login",
      useWorktree: false,
    });
    expect((fake.dispatch.mock.calls[0]?.[0] as { commandId: string }).commandId).toBeTruthy();
  });
});
