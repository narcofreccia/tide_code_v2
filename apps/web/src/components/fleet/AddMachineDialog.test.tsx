import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

vi.mock("../../state/environments.ts", async () => (await import("./testEnvironments.ts")).fakeEnvironmentsModule());

import * as envs from "../../state/environments.ts";
import { mockRpc } from "../../testHarness.ts";
import { AddMachineDialog } from "./AddMachineDialog.tsx";
import { closeAddMachine, openAddMachine } from "./fleetUi.ts";

afterEach(() => {
  cleanup();
  closeAddMachine();
  vi.clearAllMocks();
});

const NAS = { environmentId: "env-nas", name: "nas", version: "1.4.0", protocol: 1, host: "192.168.1.30", port: 3777, urls: ["http://192.168.1.30:3777"] };

describe("AddMachineDialog › Found on your network (R17)", () => {
  it("a discovered machine prefills the URL and moves back to the pairing-code tab", async () => {
    mockRpc({ "env.discover": () => ({ peers: [NAS], enabled: true }) });
    openAddMachine();
    render(<AddMachineDialog />);
    const sheet = screen.getByRole("dialog", { name: "Add machine" });
    fireEvent.click(within(sheet).getByRole("radio", { name: "Token" }));
    fireEvent.change(within(sheet).getByLabelText("Machine token"), { target: { value: "tok" } });

    fireEvent.click(await within(sheet).findByRole("button", { name: "Use nas" }));
    expect((within(sheet).getByLabelText("Machine URL") as HTMLInputElement).value).toBe("http://192.168.1.30:3777");
    expect(within(sheet).getByRole("radio", { name: "Pairing code" }).getAttribute("aria-checked")).toBe("true");
    expect((within(sheet).getByLabelText("Pairing code") as HTMLInputElement).value).toBe("");

    fireEvent.change(within(sheet).getByLabelText("Pairing code"), { target: { value: "123456" } });
    fireEvent.click(within(sheet).getByText("Pair"));
    await waitFor(() => expect(envs.pairWithCode).toHaveBeenCalledWith("http://192.168.1.30:3777", "123456"));
  });

  it("shows no list when the primary cannot browse", async () => {
    const rpc = mockRpc({ "env.discover": () => ({ peers: [], enabled: false }) });
    openAddMachine();
    render(<AddMachineDialog />);
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("env.discover", {}));
    expect(screen.queryByText("Found on your network")).toBeNull();
    expect(screen.getByLabelText("Machine URL")).toBeDefined();
  });
});
