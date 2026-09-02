import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { MissionControl } from "../components/mission/MissionControl.tsx";
import { HarnessFields } from "../components/thread/ProviderPicker.tsx";
import { PROVIDER_FIXTURE } from "../components/settings/fixtures.ts";
import { useProvidersStore } from "./providers.ts";
import { attachFakeStore, mockRpc, modelWith, resetUi } from "../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

/** The options a `Select` offers, with their disabled state. */
function options(label: string): { text: string; disabled: string | null }[] {
  fireEvent.click(screen.getByRole("combobox", { name: label }));
  const listbox = screen.getByRole("listbox", { name: label });
  return within(listbox)
    .getAllByRole("option")
    .map((node) => ({
      text: node.textContent?.replace(/✓$/, "").trim() ?? "",
      disabled: node.getAttribute("aria-disabled"),
    }));
}

describe("provider roster honesty", () => {
  it("offers nothing while providers.list is still in flight", () => {
    attachFakeStore(modelWith({}));
    mockRpc({ "providers.list": () => new Promise(() => undefined) });
    render(<HarnessFields name="Thread" provider="claude" model="" onChange={() => undefined} />);

    const offered = options("Thread provider");
    expect(offered.every((o) => o.disabled === "true")).toBe(true);
    expect(offered.map((o) => o.text)).toEqual([
      "claude · checking…",
      "codex · checking…",
      "opencode · checking…",
      "pi · checking…",
    ]);
  });

  it("marks every harness not installed when the probe fails", async () => {
    attachFakeStore(modelWith({}));
    mockRpc({
      "providers.list": () => {
        throw new Error("connection lost");
      },
    });
    render(<HarnessFields name="Thread" provider="claude" model="" onChange={() => undefined} />);

    await waitFor(() => expect(useProvidersStore.getState().error).toBe("connection lost"));
    const roster = useProvidersStore.getState().providers;
    expect(roster).toHaveLength(4);
    expect(roster.every((p) => !p.installed && !p.loggedIn && p.hint === "connection lost")).toBe(true);
  });

  it("never ticks the checklist off before the server has answered", async () => {
    attachFakeStore(modelWith({}));
    mockRpc({ "providers.list": () => new Promise(() => undefined) });
    render(<MissionControl />);

    expect(screen.getByText("Checking harnesses…")).toBeDefined();
    expect(screen.getByLabelText("2 Log in to a harness").dataset["done"]).toBe("false");
  });

  it("reports why the roster is unknown when the probe failed", async () => {
    attachFakeStore(modelWith({}));
    mockRpc({
      "providers.list": () => {
        throw new Error("connection lost");
      },
    });
    render(<MissionControl />);

    expect(await screen.findByText("Could not reach the server: connection lost")).toBeDefined();
    expect(screen.getByLabelText("2 Log in to a harness").dataset["done"]).toBe("false");
  });

  it("offers a harness once the server says it is ready", async () => {
    attachFakeStore(modelWith({}));
    mockRpc({ "providers.list": () => PROVIDER_FIXTURE });
    render(<HarnessFields name="Thread" provider="claude" model="" onChange={() => undefined} />);

    await waitFor(() => expect(useProvidersStore.getState().providers).toHaveLength(4));
    const offered = options("Thread provider");
    expect(offered[0]).toEqual({ text: "claude", disabled: "false" });
    expect(offered[1]?.disabled).toBe("true");
  });
});
