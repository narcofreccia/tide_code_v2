import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NewThreadDialogHost } from "./NewThreadPopover.tsx";
import { attachFakeStore, chooseOption, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { createChild } from "../../lib/threadActions.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

function open(parentThreadId?: string, threads?: Record<string, ReturnType<typeof makeThread>>) {
  const fake = attachFakeStore(
    modelWith({
      projects: { p1: project },
      threads: threads ?? { t1: makeThread("t1", { title: "Parent", provider: "codex" }) },
    }),
  );
  render(<NewThreadDialogHost />);
  act(() => useUi.getState().openNewThread({ projectId: "p1", ...(parentThreadId ? { parentThreadId } : {}) }));
  return fake;
}

async function created(fake: ReturnType<typeof open>): Promise<Record<string, unknown>> {
  await waitFor(() => expect(fake.dispatch).toHaveBeenCalled());
  return fake.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("new thread form", () => {
  it("leaves the title to the first message unless one is typed", async () => {
    const fake = open();
    const title = screen.getByLabelText("Thread title") as HTMLInputElement;
    expect(document.activeElement).toBe(title);
    expect(screen.getByText("Optional. Named from your first message otherwise.")).toBeDefined();
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["title"]).toBe("New thread");
  });

  it("states the outcome: project in the heading, permission hint as caption", () => {
    open();
    expect(screen.getByRole("heading", { name: "Start a thread on Tide" })).toBeDefined();
    chooseOption("Thread permissions", "Full access");
    expect(screen.getByText("Never asks — use with care")).toBeDefined();
  });

  it("⌘↵ creates from any field", async () => {
    const fake = open();
    fireEvent.keyDown(screen.getByRole("radio", { name: "Plan" }), { key: "Enter", metaKey: true });
    expect((await created(fake))["type"]).toBe("thread.create");
  });

  it("sends a typed title", async () => {
    const fake = open();
    fireEvent.change(screen.getByLabelText("Thread title"), { target: { value: "  Fix login  " } });
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["title"]).toBe("Fix login");
  });

  it("offers the four permission modes and sends the chosen one", async () => {
    const fake = open();
    chooseOption("Thread permissions", "Full access");
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["mode"]).toBe("full-access");
  });

  it("defaults permissions to the Settings › Providers default", () => {
    useServerSettings.setState((s) => ({
      settings: { ...s.settings, providerDefaults: { claude: { mode: "auto-accept-edits" } } },
    }));
    open(undefined, {});
    expect(screen.getByRole("combobox", { name: "Thread permissions" }).textContent).toContain("Auto-edit");
  });

  it("defaults agent, model and permissions to the project's most recent thread", async () => {
    const fake = open(undefined, {
      old: makeThread("old", { provider: "claude", createdAt: 1 }),
      recent: makeThread("recent", { provider: "codex", model: "gpt-x", mode: "full-access", createdAt: 5 }),
    });
    fireEvent.click(screen.getByText("Create thread"));
    const cmd = await created(fake);
    expect(cmd["provider"]).toBe("codex");
    expect(cmd["model"]).toBe("gpt-x");
    expect(cmd["mode"]).toBe("full-access");
  });

  it("switches Build | Plan and sends interaction plan", async () => {
    const fake = open();
    expect(screen.getByRole("radio", { name: "Build" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Plan" }));
    fireEvent.click(screen.getByText("Create thread"));
    expect((await created(fake))["interaction"]).toBe("plan");
  });

  it("creates a child prefilled from the parent and honours worktreeByDefault", async () => {
    useServerSettings.setState((s) => ({ settings: { ...s.settings, worktreeByDefault: false } }));
    const fake = open("t1");
    expect(screen.getByRole("dialog", { name: "New child thread" })).toBeDefined();
    expect(screen.getByText("Child of “Parent”")).toBeDefined();
    fireEvent.click(screen.getByText("Create child thread"));
    const command = await created(fake);
    expect(command).toMatchObject({ type: "thread.create", parentThreadId: "t1", provider: "codex", useWorktree: false });
  });

  it("createChild opens the form instead of creating silently", () => {
    const fake = attachFakeStore(modelWith({ projects: { p1: project }, threads: { t1: makeThread("t1") } }));
    createChild({ id: "t1", projectId: "p1" });
    expect(useUi.getState().newThreadProjectId).toBe("p1");
    expect(useUi.getState().newThreadParentId).toBe("t1");
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("openNewThread finds the project from the parent alone", () => {
    attachFakeStore(modelWith({ projects: { p1: project }, threads: { t1: makeThread("t1") } }));
    useUi.getState().openNewThread({ parentThreadId: "t1" });
    expect(useUi.getState().newThreadProjectId).toBe("p1");
  });
});
