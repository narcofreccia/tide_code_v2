import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../testHarness.ts";
import { ThreadPills } from "../components/thread/ThreadPills.tsx";
import { SettingsView } from "../components/settings/SettingsView.tsx";
import { PROVIDER_FIXTURE } from "../components/settings/fixtures.ts";
import { setProvidersForTest } from "./providers.ts";
import { useEnvironments } from "./environments.ts";
import { useUi } from "./ui.ts";
import { defaultUserSettings, patchServerSettings, useServerSettings } from "./serverSettings.ts";
import { useToasts } from "./toast.ts";
import { deviceLimitReason } from "./deviceAccess.ts";

const REASON = deviceLimitReason("studio");

function onMachine(access: "limited" | "full" | undefined): void {
  useEnvironments.setState({
    environments: [{ id: "env-1", name: "studio", routes: [], addedAt: 0, ...(access === undefined ? {} : { clientId: "c-phone" }) }],
    statuses: { "env-1": { connection: "connected", info: { environmentId: "env-1", name: "studio", version: "1", startedAt: 1, ...(access ? { access } : {}) } } },
    primaryId: "env-1",
  });
}

afterEach(() => {
  cleanup();
  resetUi();
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
  useServerSettings.setState({ settings: defaultUserSettings(), loaded: true, error: undefined, selectedId: undefined });
  useToasts.setState({ toasts: [] });
});

/** Opens the Permissions pill (unless open) and returns the option named `name`. */
function permissionsOption(name: string): HTMLElement {
  if (screen.queryByRole("listbox", { name: "Permissions" }) === null) fireEvent.click(screen.getByRole("combobox", { name: "Permissions" }));
  return within(screen.getByRole("listbox", { name: "Permissions" })).getByRole("option", { name: new RegExp(`^${name}`) });
}

function openSettings(section: "general" | "appearance"): void {
  setProvidersForTest(PROVIDER_FIXTURE);
  useServerSettings.setState({ loaded: true });
  useUi.setState({ view: "thread" });
  useUi.getState().openSettings(section);
  render(<SettingsView />);
}

describe("a device with limited access (R19)", () => {
  it("cannot pick Full access mode; the option says why", () => {
    onMachine("limited");
    setProvidersForTest(PROVIDER_FIXTURE);
    attachFakeStore(modelWith({}));
    render(<ThreadPills thread={makeThread("t1")} />);
    const full = permissionsOption("Full access");
    expect(full.getAttribute("aria-disabled")).toBe("true");
    expect(full.title).toBe(REASON);
    expect(permissionsOption("Ask first").getAttribute("aria-disabled")).toBe("false");
  });

  it("sees a server settings page read-only with the reason on top", () => {
    onMachine("limited");
    openSettings("general");
    expect(screen.getByRole("note").textContent).toBe(`Read-only. ${REASON}`);
    const block = screen.getByTestId("settings-read-only");
    expect(block.hasAttribute("inert")).toBe(true);
    expect(block.contains(screen.getByLabelText("Title instructions"))).toBe(true);
  });

  it("keeps client-only settings usable", () => {
    onMachine("limited");
    openSettings("appearance");
    expect(screen.queryByTestId("settings-read-only")).toBeNull();
  });

  it("does not send a settings write; it shows the reason", async () => {
    onMachine("limited");
    await patchServerSettings({ followUpMode: "queue" });
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual([REASON]);
  });
});

describe("the owner and a device with full access (R19)", () => {
  for (const access of [undefined, "full"] as const) {
    it(`sees everything enabled (access: ${access ?? "absent"})`, () => {
      onMachine(access);
      setProvidersForTest(PROVIDER_FIXTURE);
      attachFakeStore(modelWith({}));
      render(<ThreadPills thread={makeThread("t1")} />);
      expect(permissionsOption("Full access").getAttribute("aria-disabled")).toBe("false");
      cleanup();
      openSettings("general");
      expect(screen.queryByTestId("settings-read-only")).toBeNull();
      expect(screen.queryByRole("note")).toBeNull();
    });
  }
});
