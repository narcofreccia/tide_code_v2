import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ScheduledTask } from "@tide/contracts";
import { fromLocalInput, TaskDialog, toLocalInput, validateDraft } from "./TaskDialog.tsx";
import { mockRpc, resetUi } from "../../testHarness.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { PROVIDER_FIXTURE } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  resetUi();
  vi.useRealTimers();
});

const NOW = new Date(2026, 10, 4, 10, 0, 0).getTime();

function mount(task?: ScheduledTask) {
  setProvidersForTest(PROVIDER_FIXTURE);
  mockRpc({});
  const onSubmit = vi.fn();
  render(<TaskDialog {...(task ? { task } : {})} threads={[]} onSubmit={onSubmit} onCancel={() => undefined} />);
  return onSubmit;
}

describe("TaskDialog › once", () => {
  it("round-trips local datetime-local values", () => {
    const ms = new Date(2026, 10, 6, 14, 30).getTime();
    expect(toLocalInput(ms)).toBe("2026-11-06T14:30");
    expect(fromLocalInput("2026-11-06T14:30")).toBe(ms);
    expect(fromLocalInput("")).toBeNaN();
    expect(fromLocalInput("garbage")).toBeNaN();
  });

  it("submits a once schedule from the Once at radio", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const onSubmit = mount();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Remind me" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "check the deploy" } });
    fireEvent.click(screen.getByRole("radio", { name: "Once at" }));
    expect((screen.getByLabelText("Run at") as HTMLInputElement).value).toBe("2026-11-04T11:00"); // next full hour
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-11-06T14:30" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ title: "Remind me", schedule: { kind: "once", at: new Date(2026, 10, 6, 14, 30).getTime() } }));
  });

  it("refuses a past or empty time", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const onSubmit = mount();
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "T" } });
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "P" } });
    fireEvent.click(screen.getByRole("radio", { name: "Once at" }));
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "2026-11-04T09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert").textContent).toBe("Pick a time in the future.");
    fireEvent.change(screen.getByLabelText("Run at"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByRole("alert").textContent).toBe("Pick the date and time to run.");
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("edits an existing once task with the radio on and its time filled in", () => {
    const at = new Date(2026, 10, 9, 8, 15).getTime();
    mount({ id: "k", projectId: "p", title: "Once", prompt: "x", schedule: { kind: "once", at }, enabled: true, runs: 0, createdAt: 1, updatedAt: 1 });
    expect((screen.getByRole("radio", { name: "Once at" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Run at") as HTMLInputElement).value).toBe("2026-11-09T08:15");
  });

  it("validateDraft takes the clock as a parameter", () => {
    const result = validateDraft({ title: "t", prompt: "p", kind: "once", onceAt: "2026-11-04T10:00", target: "new", provider: "claude", model: "", useWorktree: true, enabled: true, hookId: "", secret: "", amount: "30", unit: "minutes", times: [], timeInput: "", weekdays: [], threadId: "" }, NOW);
    expect(result).toEqual({ error: "Pick a time in the future." });
  });
});
