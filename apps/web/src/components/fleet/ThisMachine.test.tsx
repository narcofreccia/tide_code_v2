import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UserSettings } from "@tide/contracts";
import { resetServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { mockRpc } from "../../testHarness.ts";
import { ThisMachine } from "./ThisMachine.tsx";

afterEach(() => {
  cleanup();
  resetServerSettings();
  window.localStorage.clear();
});

function server() {
  return mockRpc({
    "env.clients.list": () => ({ clients: [] }),
    "settings.set": ({ patch }: { patch: { environment?: { lanBind?: boolean } } }) => {
      const current = useServerSettings.getState().settings;
      return { ...current, environment: { ...current.environment, ...patch.environment } } satisfies UserSettings;
    },
  });
}

describe("ThisMachine LAN toggle", () => {
  it("is offered in the desktop shell and saves environment.lanBind", async () => {
    window.localStorage.setItem("tide.desktop", "1");
    const rpc = server();
    render(<ThisMachine info={undefined} envId={undefined} />);
    expect(screen.getByText("Takes effect after Tide restarts")).toBeDefined();
    const toggle = screen.getByRole("switch", { name: "Reachable on the LAN" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("settings.set", { patch: { environment: { lanBind: true } } }));
    await waitFor(() => expect((screen.getByRole("switch", { name: "Reachable on the LAN" }) as HTMLInputElement).checked).toBe(true));
  });

  it("is hidden in a plain browser tab", () => {
    server();
    render(<ThisMachine info={undefined} envId={undefined} />);
    expect(screen.queryByRole("switch", { name: "Reachable on the LAN" })).toBeNull();
  });
});
