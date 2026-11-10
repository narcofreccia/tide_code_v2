import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PairedClient } from "@tide/contracts";
import { useEnvironments } from "../../state/environments.ts";
import { mockRpc } from "../../testHarness.ts";
import { PairDevice } from "./PairDevice.tsx";
import { PairedDevices } from "./PairedDevices.tsx";

afterEach(() => {
  cleanup();
  useEnvironments.setState({ environments: [], primaryId: undefined });
});

const NOW = Date.now();

function serverWith(initial: PairedClient[]) {
  let clients = initial;
  return mockRpc({
    "env.clients.list": () => ({ clients }),
    "env.clients.revoke": ({ id }: { id: string }) => {
      clients = clients.filter((c) => c.id !== id);
      return { ok: true };
    },
  });
}

describe("PairedDevices", () => {
  it("lists the primary's devices for the owner and revokes after confirming", async () => {
    // the owner holds the master token: no clientId on the record
    useEnvironments.setState({ environments: [{ id: "env-1", name: "box", routes: [], addedAt: 0 }], primaryId: "env-1" });
    const rpc = serverWith([
      { id: "c-me", name: "Firefox on Linux", createdAt: NOW - 86_400_000, lastSeenAt: NOW },
      { id: "c-phone", name: "Safari on iOS", createdAt: NOW - 3 * 86_400_000, lastSeenAt: NOW - 2 * 3_600_000, lastAddress: "10.0.0.7" },
    ]);
    render(<PairedDevices envId="env-1" />);
    const list = await screen.findByRole("list", { name: "Paired devices" });
    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(screen.queryByText("this device")).toBeNull();
    expect(within(rows[1] as HTMLElement).getByText(/seen 2h/)).toBeDefined();
    expect(rpc).toHaveBeenCalledWith("env.clients.list", {}, { envId: "env-1" });

    fireEvent.click(screen.getByRole("button", { name: "Revoke Safari on iOS" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Paired devices" })).getAllByRole("listitem")).toHaveLength(1));
    expect(rpc).toHaveBeenCalledWith("env.clients.revoke", { id: "c-phone" }, { envId: "env-1" });
    expect(rpc.mock.calls.filter(([m]) => m === "env.clients.list")).toHaveLength(2);
  });

  it("cancel keeps the device; an empty list says so", async () => {
    const rpc = serverWith([{ id: "c1", name: "device", createdAt: NOW }]);
    render(<PairedDevices envId={undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke device" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(rpc.mock.calls.some(([m]) => m === "env.clients.revoke")).toBe(false);
    expect(screen.getByText(/never seen/)).toBeDefined();
    cleanup();
    serverWith([]);
    render(<PairedDevices envId={undefined} />);
    expect(await screen.findByText(/No device has paired/)).toBeDefined();
  });

  it("shows an error when the server cannot list devices", async () => {
    mockRpc({});
    render(<PairedDevices envId={undefined} />);
    expect((await screen.findByRole("alert")).textContent).toContain("env.clients.list");
  });

  it("on a paired device: shows only this device, revocable, and no pairing button", async () => {
    useEnvironments.setState({ environments: [{ id: "env-1", name: "box", routes: [], addedAt: 0, clientId: "c-me" }], primaryId: "env-1" });
    const rpc = serverWith([{ id: "c-me", name: "Safari on iOS", createdAt: NOW }]);
    render(
      <>
        <PairDevice envId="env-1" />
        <PairedDevices envId="env-1" />
      </>,
    );
    expect(await screen.findByRole("button", { name: "Revoke Safari on iOS" })).toBeDefined();
    expect(screen.getByText("This device")).toBeDefined();
    expect(screen.getByText("this device")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Pair another device" })).toBeNull();
    expect(rpc.mock.calls.some(([m]) => m === "env.pairingCode")).toBe(false);
  });

  it("a forbidden answer hides the row instead of showing an error", async () => {
    mockRpc({
      "env.clients.list": () => {
        throw Object.assign(new Error("only the owner"), { code: "forbidden" });
      },
    });
    const { container } = render(<PairedDevices envId={undefined} />);
    await waitFor(() => expect(container.textContent).toBe(""));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("the owner keeps the pairing button", () => {
    useEnvironments.setState({ environments: [{ id: "local", name: "here", routes: [], addedAt: 0 }], primaryId: "local" });
    render(<PairDevice envId="local" />);
    expect(screen.getByRole("button", { name: "Pair another device" })).toBeDefined();
  });
});
