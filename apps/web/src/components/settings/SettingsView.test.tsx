import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("lists the six sections and remembers the last one", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<SettingsView />);
    const nav = screen.getByLabelText("Settings sections");
    expect([...nav.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
      "Providers",
      "Git",
      "Appearance",
      "Keyboard",
      "Remote",
      "About",
    ]);
    expect(screen.getByText("Refresh all")).toBeDefined();

    fireEvent.click(screen.getByText("Keyboard"));
    expect(useUi.getState().settingsSection).toBe("keyboard");
    expect(screen.getByRole("table")).toBeDefined();

    fireEvent.click(screen.getByText("Appearance"));
    expect(screen.getByLabelText("Theme")).toBeDefined();
    expect(useUi.getState().settingsSection).toBe("appearance");
  });

  it("shows the read-only Git and Remote panels", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    attachFakeStore(modelWith({}));
    render(<SettingsView />);
    fireEvent.click(screen.getByText("Git"));
    expect(screen.getByText("~/.tide/worktrees")).toBeDefined();
    expect(screen.getByLabelText("Settings").textContent).toContain(
      "Create a worktree for new threads by default",
    );

    fireEvent.click(screen.getByText("Remote"));
    expect(screen.getByText(/lands in a later phase/)).toBeDefined();
  });
});
