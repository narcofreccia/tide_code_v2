import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PairedClient } from "@tide/contracts";
import { useEnvironments } from "../../state/environments.ts";
import { chooseOption, mockRpc } from "../../testHarness.ts";
import { useToasts } from "../../state/toast.ts";
import { PairDevice } from "./PairDevice.tsx";
import { PairedDevices } from "./PairedDevices.tsx";

afterEach(() => {
  cleanup();
  useEnvironments.setState({ environments: [], primaryId: undefined });
});

const NOW = Date.now();
const toastTexts = (): string[] => useToasts.getState().toasts.map((t) => t.text);

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

describe("access levels (R19)", () => {
  const owner = (): void => {
    useEnvironments.setState({ environments: [{ id: "env-1", name: "box", routes: [], addedAt: 0 }], primaryId: "env-1" });
  };

  it("pairs with limited access by default; the switch asks for a new code with full access", async () => {
    owner();
    const rpc = mockRpc({
      "env.pairingCode": ({ access }: { access?: string }) => ({ code: access === "full" ? "222222" : "111111", expiresAt: Date.now() + 300_000, urls: [] }),
    });
    render(<PairDevice envId="env-1" />);
    fireEvent.click(screen.getByRole("button", { name: "Pair another device" }));
    expect((await screen.findByTestId("pairing-code")).textContent).toBe("111111");
    expect(rpc).toHaveBeenCalledWith("env.pairingCode", { access: "limited" }, { envId: "env-1" });
    expect(screen.getByText(/pairs with limited access/)).toBeDefined();

    fireEvent.click(screen.getByRole("switch", { name: "Full access" }));
    await waitFor(() => expect(screen.getByTestId("pairing-code").textContent).toBe("222222"));
    expect(rpc).toHaveBeenLastCalledWith("env.pairingCode", { access: "full" }, { envId: "env-1" });
    expect(screen.getByText(/pairs with full access/)).toBeDefined();
  });

  it("shows each device's level and lets the owner change it", async () => {
    owner();
    let clients: PairedClient[] = [
      { id: "c-phone", name: "Safari on iOS", createdAt: NOW, access: "limited" },
      { id: "c-old", name: "Old laptop", createdAt: NOW },
    ];
    const rpc = mockRpc({
      "env.clients.list": () => ({ clients }),
      "env.clients.setAccess": ({ id, access }: { id: string; access: "limited" | "full" }) => {
        clients = clients.map((c) => (c.id === id ? { ...c, access } : c));
        return { ok: true };
      },
    });
    render(<PairedDevices envId="env-1" />);
    const phone = await screen.findByRole("combobox", { name: "Access for Safari on iOS" });
    expect(phone.textContent).toContain("Limited");
    // a row from before access levels has full access
    expect(screen.getByRole("combobox", { name: "Access for Old laptop" }).textContent).toContain("Full access");

    chooseOption("Access for Safari on iOS", /^Full access/);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("env.clients.setAccess", { id: "c-phone", access: "full" }, { envId: "env-1" }));
    expect(screen.getByRole("combobox", { name: "Access for Safari on iOS" }).textContent).toContain("Full access");
  });

  it("says so when the server refuses or the device is gone, and reloads the list", async () => {
    owner();
    let answer: () => unknown = () => ({ ok: false });
    const rpc = mockRpc({
      "env.clients.list": () => ({ clients: [{ id: "c1", name: "tablet", createdAt: NOW, access: "limited" }] }),
      "env.clients.setAccess": () => answer(),
    });
    useToasts.setState({ toasts: [] });
    render(<PairedDevices envId="env-1" />);
    await screen.findByRole("combobox", { name: "Access for tablet" });
    chooseOption("Access for tablet", /^Full access/);
    await waitFor(() => expect(toastTexts()).toEqual(["Changing access for “tablet” failed: that device is no longer paired"]));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Access for tablet" }).textContent).toContain("Limited"));

    answer = () => {
      throw Object.assign(new Error("only the owner"), { code: "forbidden" });
    };
    chooseOption("Access for tablet", /^Full access/);
    await waitFor(() => expect(toastTexts()).toContain("Changing access for “tablet” failed: only the owner of the machine can change it"));
    expect(rpc.mock.calls.filter(([m]) => m === "env.clients.list").length).toBeGreaterThanOrEqual(3);
  });

  it("a paired device sees its own level read-only", async () => {
    useEnvironments.setState({ environments: [{ id: "env-1", name: "box", routes: [], addedAt: 0, clientId: "c-me" }], primaryId: "env-1" });
    mockRpc({ "env.clients.list": () => ({ clients: [{ id: "c-me", name: "Safari on iOS", createdAt: NOW, access: "limited" }] }) });
    render(<PairedDevices envId="env-1" />);
    expect(await screen.findByText("Limited")).toBeDefined();
    expect(screen.queryByRole("combobox", { name: /Access for/ })).toBeNull();
  });
});
