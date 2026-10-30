import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ThreadPills } from "./ThreadPills.tsx";
import { NewThreadDialogHost } from "../shell/NewThreadPopover.tsx";
import { attachFakeStore, chooseOption, makeThread, modelWith, optionLabels, resetUi } from "../../testHarness.ts";
import { CODEX_WORK, GEMINI, PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { providerStatus, setProvidersForTest } from "../../state/providers.ts";
import { resetServerSettings } from "../../state/serverSettings.ts";
import { useToasts } from "../../state/toast.ts";
import { useUi } from "../../state/ui.ts";
import { useWorkbench } from "../../state/workbench.ts";
import { handleShortcut, SHORTCUTS } from "../../lib/shortcuts.ts";
import {
  PROVIDER_LABELS,
  PROVIDER_MONOGRAMS,
  PROVIDERS,
  instanceLabel,
  providerIdOf,
  threadHarnessLabel,
} from "../../lib/vocab.ts";

afterEach(() => {
  cleanup();
  resetUi();
  resetServerSettings();
});

const ROSTER = [...PROVIDER_FIXTURE, CODEX_WORK, GEMINI];

describe("instance vocabulary", () => {
  it("knows the ACP kind", () => {
    expect(PROVIDERS).toContain("acp");
    expect(PROVIDER_LABELS.acp).toBe("ACP agent");
    expect(PROVIDER_MONOGRAMS.acp).toBe("A");
  });

  it("resolves a thread's instance and its label", () => {
    expect(providerIdOf({ provider: "codex" })).toBe("codex");
    expect(providerIdOf({ provider: "codex", providerId: "codex:work" })).toBe("codex:work");
    expect(instanceLabel(ROSTER, "codex:work")).toBe("Codex · work");
    expect(instanceLabel(ROSTER, "pi")).toBe("Pi");
    expect(instanceLabel([], "acp:gone")).toBe("acp:gone");
    expect(threadHarnessLabel(ROSTER, { provider: "claude" })).toBe("Claude Code");
    expect(threadHarnessLabel(ROSTER, { provider: "acp", providerId: "acp:gemini" })).toBe("Gemini CLI");
  });

  it("finds a status by id first, then the default instance of a kind", () => {
    expect(providerStatus(ROSTER, "codex:work")?.label).toBe("Codex · work");
    expect(providerStatus(ROSTER, "codex")?.id).toBe("codex");
    expect(providerStatus(ROSTER, "acp")).toBeUndefined();
  });
});

function mountPills(patch: Parameters<typeof makeThread>[1] = {}) {
  setProvidersForTest(ROSTER);
  const thread = makeThread("t1", patch);
  const fake = attachFakeStore(modelWith({ threads: { t1: thread } }));
  render(<ThreadPills thread={thread} />);
  return fake;
}

describe("ThreadPills instances", () => {
  it("lists instances grouped: harnesses, then accounts, then ACP agents", () => {
    mountPills();
    const labels = optionLabels("Provider");
    expect(labels.indexOf("Codex · work")).toBeGreaterThan(labels.findIndex((l) => l.startsWith("Pi")));
    expect(labels.indexOf("Gemini CLI")).toBeGreaterThan(labels.indexOf("Codex · work"));
    fireEvent.click(screen.getByRole("combobox", { name: "Provider" }));
    expect(screen.getByText("Accounts")).toBeDefined();
    expect(screen.getByText("ACP agents")).toBeDefined();
  });

  it("switches the instance with its kind and default model", () => {
    const fake = mountPills();
    chooseOption("Provider", "Codex · work");
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "thread.update",
      threadId: "t1",
      provider: "codex",
      providerId: "codex:work",
      model: "gpt-5-codex",
    });
  });

  it("shows no Effort pill when the model lists no efforts", () => {
    mountPills();
    expect(screen.queryByRole("combobox", { name: "Effort" })).toBeNull();
  });

  it("offers the model's efforts plus Default, and Default clears it", () => {
    const fake = mountPills({ provider: "codex", providerId: "codex:work", effort: "high" });
    expect(optionLabels("Effort")).toEqual(["DefaultThe harness default (Medium)", "Low", "Medium", "High"]);
    chooseOption("Effort", "Low");
    expect(fake.dispatch).toHaveBeenLastCalledWith({ type: "thread.update", threadId: "t1", effort: "low" });
    chooseOption("Effort", /^Default/);
    expect(fake.dispatch).toHaveBeenLastCalledWith({ type: "thread.update", threadId: "t1", effort: "" });
  });
});

describe("⌘⇧E", () => {
  function select(patch: Parameters<typeof makeThread>[1]) {
    setProvidersForTest(ROSTER);
    useToasts.setState({ toasts: [] });
    const fake = attachFakeStore(modelWith({ threads: { t1: makeThread("t1", patch) } }));
    useUi.getState().selectThread("t1");
    return fake;
  }
  const press = (): boolean => handleShortcut(new KeyboardEvent("keydown", { key: "E", metaKey: true, shiftKey: true }));

  it("is registered in the Thread group", () => {
    expect(SHORTCUTS.find((s) => s.id === "effort")).toMatchObject({ keys: "⌘⇧E", group: "Thread" });
  });

  it("cycles the effort while the thread has the screen", () => {
    const fake = select({ provider: "codex", providerId: "codex:work", effort: "medium" });
    act(() => useUi.getState().setFocusMode("thread"));
    expect(press()).toBe(true);
    expect(fake.dispatch).toHaveBeenLastCalledWith({ type: "thread.update", threadId: "t1", effort: "high" });
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Effort: High"]);
  });

  it("leaves the key to the file tree when the workbench owns focus", () => {
    const fake = select({ provider: "codex", providerId: "codex:work" });
    act(() => useUi.getState().setFocusMode("split"));
    const before = useWorkbench.getState().treeVisible;
    expect(press()).toBe(true);
    expect(useWorkbench.getState().treeVisible).toBe(!before);
    expect(fake.dispatch).not.toHaveBeenCalled();
  });
});

describe("new thread on an instance", () => {
  it("sends providerId and effort in thread.create", async () => {
    setProvidersForTest(ROSTER);
    const fake = attachFakeStore(
      modelWith({ projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } } }),
    );
    render(<NewThreadDialogHost />);
    act(() => useUi.getState().openNewThread({ projectId: "p1" }));
    expect(screen.queryByRole("combobox", { name: "Thread effort" })).toBeNull();
    chooseOption("Thread provider", "Codex · work");
    chooseOption("Thread effort", "High");
    fireEvent.click(screen.getByText("Create thread"));
    await waitFor(() => expect(fake.dispatch).toHaveBeenCalled());
    expect(fake.dispatch.mock.calls[0]?.[0]).toMatchObject({
      type: "thread.create",
      provider: "codex",
      providerId: "codex:work",
      model: "gpt-5-codex",
      effort: "high",
    });
  });

  it("omits providerId for a bundled default", async () => {
    setProvidersForTest(ROSTER);
    const fake = attachFakeStore(
      modelWith({ projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } } }),
    );
    render(<NewThreadDialogHost />);
    act(() => useUi.getState().openNewThread({ projectId: "p1" }));
    fireEvent.click(screen.getByText("Create thread"));
    await waitFor(() => expect(fake.dispatch).toHaveBeenCalled());
    const command = fake.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(command["provider"]).toBe("claude");
    expect("providerId" in command).toBe(false);
    expect("effort" in command).toBe(false);
  });
});
