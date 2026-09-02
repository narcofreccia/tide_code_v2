import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ThreadPills } from "./ThreadPills.tsx";
import { attachFakeStore, chooseOption, makeThread, modelWith, optionLabels, resetUi } from "../../testHarness.ts";
import { PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { useToasts } from "../../state/toast.ts";

afterEach(() => {
  cleanup();
  resetUi();
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
    expect(optionLabels("Model")).toEqual(["harness default", "Opus 4.6", "Sonnet 4.6"]);
  });

  it("says why an unavailable harness cannot be picked", () => {
    const fake = mount();
    expect(optionLabels("Provider").find((l) => l.startsWith("codex"))).toMatch(/·/);
    chooseOption("Provider", /^codex/);
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("changes the model quietly while the thread is idle", () => {
    const fake = mount();
    chooseOption("Model", "Opus 4.6");
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.update", threadId: "t1", model: "opus-4-6" });
    expect(toasts()).toEqual([]);
  });

  it("says a mid-turn change applies from the next turn", () => {
    const fake = mount({ status: "running" });
    chooseOption("Mode", "auto-accept-edits");
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "thread.update", threadId: "t1" }),
    );
    expect(toasts()).toEqual(["Applies from the next turn"]);
  });

  it("keeps the provider fixed while the thread runs", () => {
    mount({ status: "running" });
    expect(screen.getByLabelText<HTMLButtonElement>("Provider").disabled).toBe(true);
    expect(screen.getByLabelText<HTMLButtonElement>("Model").disabled).toBe(false);
  });
});
