import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../../App.tsx";
import { SettingsView } from "./SettingsView.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { PROVIDER_FIXTURE } from "./fixtures.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Settings view", () => {
  it("opens with ⌘, and returns to the previous view on Esc", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    const thread = makeThread("t1");
    attachFakeStore(modelWith({ threads: { t1: thread }, threadMessages: { t1: [] } }));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(<App />);

    fireEvent.keyDown(window, { key: ",", metaKey: true });
    expect(useUi.getState().view).toBe("settings");
    expect(screen.getByLabelText("Settings sections")).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(useUi.getState().view).toBe("thread");
  });

  it("lists the sections and remembers the last one", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<SettingsView />);
    const nav = screen.getByLabelText("Settings sections");
    expect([...nav.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "General",
      "Projects",
      "Inbox",
      "Notifications",
      "Providers",
      "Git",
      "Decisions",
      "Automations",
      "Teams",
      "Appearance",
      "Keyboard",
      "Environments",
      "Glass box",
      "About",
    ]);
    expect(screen.getByText("Refresh all")).toBeDefined();

    fireEvent.click(screen.getByText("Keyboard"));
    expect(useUi.getState().settingsSection).toBe("keyboard");
    expect(screen.getByRole("table")).toBeDefined();

    fireEvent.click(screen.getByText("Appearance"));
    expect(screen.getByRole("combobox", { name: "Theme" })).toBeDefined();
    expect(useUi.getState().settingsSection).toBe("appearance");
  });

  it("shows the read-only Git and the Environments panels", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    attachFakeStore(modelWith({}));
    render(<SettingsView />);
    fireEvent.click(screen.getByText("Git"));
    expect(screen.getByText("~/.tide/worktrees")).toBeDefined();
    expect(screen.getByLabelText("Settings").textContent).toContain(
      "Create a worktree for new threads by default",
    );

    fireEvent.click(screen.getByText("Environments"));
    expect(screen.getByText(/tide-server --host 0.0.0.0/)).toBeDefined();
  });

  it("search filters the nav and jumps to a row in another section", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    attachFakeStore(modelWith({}));
    render(<SettingsView />);
    fireEvent.change(screen.getByLabelText("Search settings"), { target: { value: "merge back" } });
    const nav = screen.getByLabelText("Settings sections");
    expect([...nav.querySelectorAll("li")].map((li) => li.textContent)).toEqual(["Inbox", "Git"]);
    const results = screen.getByLabelText("Matching settings");
    fireEvent.click(within(results).getByText(/Merge back strategy/));
    expect(useUi.getState().settingsSection).toBe("git");
    const row = document.getElementById("setting-merge-back-strategy");
    expect(row?.hasAttribute("data-flash")).toBe(true);

    fireEvent.keyDown(screen.getByLabelText("Search settings"), { key: "Escape" });
    expect((screen.getByLabelText("Search settings") as HTMLInputElement).value).toBe("");
    expect(useUi.getState().view).not.toBe("thread");
  });
});
