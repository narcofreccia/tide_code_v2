import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ThreadPills } from "./ThreadPills.tsx";
import { attachFakeStore, chooseOption, makeThread, modelWith, optionLabels, resetUi } from "../../testHarness.ts";
import { PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { resetServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { useToasts } from "../../state/toast.ts";

afterEach(() => {
  cleanup();
  resetUi();
  resetServerSettings();
});

function mount(patch: Parameters<typeof makeThread>[1] = {}) {
  useToasts.setState({ toasts: [] });
  setProvidersForTest(PROVIDER_FIXTURE);
  const fake = attachFakeStore(modelWith({}));
  render(<ThreadPills thread={makeThread("t1", patch)} />);
  return fake;
}

const toasts = (): string[] => useToasts.getState().toasts.map((t) => t.text);

describe("ThreadPills", () => {
  it("lists the harness's own models, never a hardcoded table", () => {
    mount();
    expect(optionLabels("Model")).toEqual(["Opus 4.6", "Sonnet 4.6Claude Code's default"]);
  });

  it("shows the harness default as selected when the thread names no model", () => {
    mount();
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("Sonnet 4.6");
  });

  it("offers the synthetic default only when the harness names none", () => {
    useToasts.setState({ toasts: [] });
    setProvidersForTest([
      { ...PROVIDER_FIXTURE[0]!, models: [{ id: "a", label: "Alpha" }, { id: "b", label: "Beta" }] },
      ...PROVIDER_FIXTURE.slice(1),
    ]);
    attachFakeStore(modelWith({}));
    render(<ThreadPills thread={makeThread("t1")} />);
    expect(optionLabels("Model")).toEqual(["Default modelWhatever Claude Code picks", "Alpha", "Beta"]);
  });

  it("says why an unavailable harness cannot be picked", () => {
    const fake = mount();
    expect(optionLabels("Provider").find((l) => l.startsWith("Codex"))).toMatch(/·/);
    chooseOption("Provider", /^Codex/);
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("changes the model quietly while the thread is idle", () => {
    const fake = mount();
    chooseOption("Model", "Opus 4.6");
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.update", threadId: "t1", model: "opus-4-6" });
    expect(toasts()).toEqual([]);
  });

  it("applies mid-turn permission changes immediately and tells the user model/mode changes apply next turn", () => {
    const fake = mount({ status: "running" });
    chooseOption("Permissions", /^Auto-edit/);
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.update", threadId: "t1", mode: "auto-accept-edits" }),
    );
    expect(toasts()).toEqual([]);

    chooseOption("Model", "Opus 4.6");
    expect(toasts()).toEqual(["Applies from the next turn"]);
  });

  it("keeps the provider fixed while the thread runs", () => {
    mount({ status: "running" });
    expect(screen.getByLabelText<HTMLButtonElement>("Provider").disabled).toBe(true);
    expect(screen.getByLabelText<HTMLButtonElement>("Model").disabled).toBe(false);
  });

  it("shows caption + value for every pill", () => {
    mount();
    for (const caption of ["Agent", "Model", "Permissions", "Mode"]) expect(screen.getByText(caption)).toBeDefined();
    expect(screen.getByLabelText("Provider").textContent).toContain("Claude Code");
    expect(screen.getByLabelText("Permissions").textContent).toContain("Ask first");
  });

  it("explains permissions and Build/Plan in plain words", () => {
    mount();
    expect(screen.getByTitle("Asks before every edit and command")).toBeDefined();
    expect(optionLabels("Permissions")).toEqual([
      "Ask firstAsks before every edit and command",
      "Auto-editEdits files freely, asks before commands",
      "AutoThe agent decides when to ask",
      "Full accessNever asks — use with care",
    ]);
    expect(screen.getByRole("radio", { name: "Plan" }).getAttribute("title")).toBe(
      "Proposes a plan first; changes nothing until you approve",
    );
  });

  it("says what Auto does on a harness where it means something else (Pi runs every tool unasked)", () => {
    mount({ provider: "pi", mode: "auto" });
    expect(optionLabels("Permissions")).toContain("AutoAuto on Pi runs every tool without asking (pi has no sandbox)");
    expect(screen.getByTitle("Auto on Pi runs every tool without asking (pi has no sandbox)")).toBeDefined();
  });

  it("switches Build / Plan with the segmented control", () => {
    const fake = mount();
    expect(screen.getByRole("radio", { name: "Build" }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Plan" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.update", threadId: "t1", interaction: "plan" });
  });

  it("shows an unlisted stored model explicitly instead of blank Select…", () => {
    mount({ model: "gpt-6-foreign" });
    expect(screen.getByRole("combobox", { name: "Model" }).textContent).toContain("gpt-6-foreign · not listed");
  });

  it("uses a valid Settings default model when switching provider, ignoring stale foreign models", () => {
    const roster = [
      PROVIDER_FIXTURE[0]!,
      {
        ...PROVIDER_FIXTURE[1]!,
        installed: true,
        loggedIn: true,
        models: [
          { id: "gpt-5-codex", label: "GPT-5 Codex", default: true },
          { id: "gpt-5-mini", label: "GPT-5 Mini" },
        ],
      },
    ];
    useServerSettings.setState((s) => ({
      ...s,
      settings: { ...s.settings, providerDefaults: { codex: { model: "gpt-5-mini" } } },
    }));
    setProvidersForTest(roster);
    const fake = attachFakeStore(modelWith({}));
    const { rerender } = render(<ThreadPills thread={makeThread("t1", { model: "opus-4-6" })} />);
    chooseOption("Provider", "Codex");
    expect(fake.dispatch).toHaveBeenLastCalledWith({
      type: "thread.update",
      threadId: "t1",
      provider: "codex",
      providerId: "codex",
      model: "gpt-5-mini",
    });

    // A stale/foreign model saved in Settings for codex is ignored in favour of codex's own default
    useServerSettings.setState((s) => ({
      ...s,
      settings: { ...s.settings, providerDefaults: { codex: { model: "opus-4-6" } } },
    }));
    rerender(<ThreadPills thread={makeThread("t1", { model: "opus-4-6" })} />);
    chooseOption("Provider", "Codex");
    expect(fake.dispatch).toHaveBeenLastCalledWith({
      type: "thread.update",
      threadId: "t1",
      provider: "codex",
      providerId: "codex",
      model: "gpt-5-codex",
    });
  });
});

describe("ThreadPills › plan mode", () => {
  const withPlan = (planMode: boolean): void => {
    setProvidersForTest([{ ...PROVIDER_FIXTURE[0]!, caps: { ...PROVIDER_FIXTURE[0]!.caps, planMode } }, ...PROVIDER_FIXTURE.slice(1)]);
    attachFakeStore(modelWith({}));
  };

  it("offers Plan when the harness has a plan mode", () => {
    withPlan(true);
    render(<ThreadPills thread={makeThread("t1")} />);
    expect(screen.getByRole("radio", { name: "Plan" })).toBeDefined();
  });

  it("hides Plan when it does not", () => {
    withPlan(false);
    render(<ThreadPills thread={makeThread("t1")} />);
    expect(screen.queryByRole("radio", { name: "Plan" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Build" })).toBeDefined();
  });

  it("keeps a thread already in plan mode visible, disabled, with a reason", () => {
    withPlan(false);
    render(<ThreadPills thread={makeThread("t1", { interaction: "plan" })} />);
    const plan = screen.getByRole("radio", { name: "Plan" }) as HTMLButtonElement;
    expect(plan.disabled).toBe(true);
    expect(plan.title).toBe("Claude Code has no plan mode");
  });
});
