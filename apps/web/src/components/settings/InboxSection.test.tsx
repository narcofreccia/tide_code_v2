import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UserSettings, UserSettingsPatch } from "@tide/contracts";
import { InboxSection, parseDays } from "./InboxSection.tsx";
import { PROVIDER_FIXTURE } from "./fixtures.ts";
import { chooseOption, mockRpc, resetUi } from "../../testHarness.ts";
import { defaultUserSettings, useServerSettings } from "../../state/serverSettings.ts";
import { setProvidersForTest } from "../../state/providers.ts";

afterEach(() => {
  cleanup();
  resetUi();
  useServerSettings.setState({ settings: defaultUserSettings() });
});

const ONE_SHOT = PROVIDER_FIXTURE.map((p) => (p.kind === "claude" ? { ...p, caps: { ...p.caps, oneShot: true } } : p));

/** settings.set answers with the patch applied, like the server. */
function echo(): ReturnType<typeof mockRpc> {
  return mockRpc({
    "providers.list": () => ONE_SHOT,
    "settings.set": ((p: { patch: UserSettingsPatch }): UserSettings => {
      const base = useServerSettings.getState().settings;
      const { textModel, inbox, ...rest } = p.patch;
      const next = { ...base, ...rest, inbox: { ...base.inbox, ...inbox } } as UserSettings;
      if (textModel === null) delete next.textModel;
      else if (textModel !== undefined) next.textModel = textModel;
      return next;
    }) as never,
  });
}

describe("Settings › Inbox", () => {
  it("parses days as whole, non-negative numbers", () => {
    expect(parseDays("4", 3)).toBe(4);
    expect(parseDays("2.6", 3)).toBe(3);
    expect(parseDays("-1", 3)).toBe(0);
    expect(parseDays("", 3)).toBe(3);
    expect(parseDays("abc", 3)).toBe(3);
  });

  it("patches auto-settle days, merge and Working", async () => {
    const rpc = echo();
    setProvidersForTest(ONE_SHOT);
    render(<InboxSection />);
    const days = screen.getByLabelText("Auto-settle after days") as HTMLInputElement;
    expect(days.value).toBe("3");
    fireEvent.change(days, { target: { value: "0" } });
    fireEvent.blur(days);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { inbox: { autoSettleAfterDays: 0 } } });
    await waitFor(() => expect(screen.getByText("days (never)")).toBeDefined());

    fireEvent.click(screen.getByLabelText(/Auto-settle when the PR is merged/));
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { inbox: { autoSettleOnMerge: false } } });
    fireEvent.click(screen.getByLabelText(/Group running threads under/));
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { inbox: { workingSection: true } } });
  });

  it("picks the text generation model and clears it back to Automatic", async () => {
    const rpc = echo();
    setProvidersForTest(ONE_SHOT);
    render(<InboxSection />);
    chooseOption("Text generation agent", "Claude Code");
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { textModel: { provider: "claude", model: "sonnet-4-6" } } });
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Text generation model" })).toBeDefined());
    chooseOption("Text generation model", /Opus 4.6/);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { textModel: { provider: "claude", model: "opus-4-6" } } });
    chooseOption("Text generation agent", "Automatic");
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { textModel: null } });
    await waitFor(() => expect(screen.queryByRole("combobox", { name: "Text generation model" })).toBeNull());
  });

  it("edits the snooze options, trims and lowercases them, and blocks a bad entry", async () => {
    const rpc = echo();
    setProvidersForTest(ONE_SHOT);
    render(<InboxSection />);
    const field = screen.getByLabelText("Snooze options") as HTMLInputElement;
    expect(field.value).toBe("1h, tomorrow 09:00");
    fireEvent.change(field, { target: { value: "2h,  Fri 18:00 ," } });
    fireEvent.blur(field);
    expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { inbox: { snoozeOptions: ["2h", "fri 18:00"] } } });
    rpc.mockClear();
    fireEvent.change(field, { target: { value: "2h, soon" } });
    fireEvent.blur(field);
    expect(screen.getByRole("alert").textContent).toMatch(/“soon”/);
    expect(rpc).not.toHaveBeenCalledWith("settings.set", expect.anything());
  });
});
