import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { DeviceAccess } from "@tide/contracts";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../testHarness.ts";
import { ThreadHeader } from "../components/thread/ThreadHeader.tsx";
import { useEnvironments } from "./environments.ts";
import { call } from "./model.ts";
import { deviceLimitReason } from "./deviceAccess.ts";
import { useDeviceAccessRefresh } from "./accessRefresh.ts";

const REASON = deviceLimitReason("studio");
const info = (access: DeviceAccess) => ({ environmentId: "env-1", name: "studio", version: "1", startedAt: 1, access });

function onMachine(access: DeviceAccess): void {
  useEnvironments.setState({
    environments: [{ id: "env-1", name: "studio", routes: [], addedAt: 0, clientId: "c-phone" }],
    statuses: { "env-1": { connection: "connected", info: info(access) } },
    primaryId: "env-1",
  });
}

function Refresher() {
  useDeviceAccessRefresh();
  return null;
}

function mountHeader(): void {
  const thread = makeThread("t1", { nativeSessionId: "abc" });
  attachFakeStore(modelWith({ threads: { t1: thread } }));
  render(
    <>
      <Refresher />
      <ThreadHeader thread={thread} />
    </>,
  );
}

const terminal = (): HTMLButtonElement => screen.getByRole("button", { name: "Terminal" }) as HTMLButtonElement;

afterEach(() => {
  cleanup();
  resetUi();
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
});

describe("the header's Terminal button on a limited device (R19)", () => {
  it("is disabled with the reason, and the resume command is not asked for", () => {
    onMachine("limited");
    const rpc = mockRpc({ "thread.terminalCommand": () => ({ command: "claude --resume abc" }) });
    mountHeader();
    expect(terminal().disabled).toBe(true);
    expect(terminal().title).toBe(REASON);
    expect(rpc).not.toHaveBeenCalledWith("thread.terminalCommand", expect.anything());
  });
});

describe("picking up a new access level without a reload (R19)", () => {
  it("re-reads server.info when a call is answered forbidden", async () => {
    onMachine("limited");
    const rpc = mockRpc({
      "vcs.pullBase": () => {
        throw Object.assign(new Error("this device has limited access"), { code: "forbidden" });
      },
      "server.info": () => info("full"),
      "thread.terminalCommand": () => ({ command: "claude --resume abc" }),
    });
    mountHeader();
    expect(terminal().disabled).toBe(true);
    await act(async () => {
      await call("vcs.pullBase", { projectId: "p1" }).catch(() => undefined);
    });
    expect(rpc).toHaveBeenCalledWith("server.info", {}, { envId: "env-1" });
    await waitFor(() => expect(terminal().disabled).toBe(false));
    expect(useEnvironments.getState().statuses["env-1"]?.info?.access).toBe("full");
    expect(terminal().title).toBe("Open in terminal: claude --resume abc");
  });

  it("does not re-read it for other errors", async () => {
    onMachine("limited");
    const rpc = mockRpc({
      "vcs.pullBase": () => {
        throw Object.assign(new Error("nope"), { code: "conflict" });
      },
    });
    mountHeader();
    await act(async () => {
      await call("vcs.pullBase", { projectId: "p1" }).catch(() => undefined);
    });
    expect(rpc).not.toHaveBeenCalledWith("server.info", expect.anything());
  });

  it("re-reads server.info when the window regains focus", async () => {
    onMachine("limited");
    const serverInfo = vi.fn(() => info("full"));
    mockRpc({ "server.info": serverInfo, "thread.terminalCommand": () => ({ command: "claude --resume abc" }) });
    mountHeader();
    expect(terminal().disabled).toBe(true);
    await act(async () => {
      fireEvent.focus(window);
    });
    await waitFor(() => expect(terminal().disabled).toBe(false));
    expect(serverInfo).toHaveBeenCalledTimes(1);
  });

  it("leaves the owner alone on focus: its info carries no level", async () => {
    useEnvironments.setState({
      environments: [{ id: "env-1", name: "studio", routes: [], addedAt: 0 }],
      statuses: { "env-1": { connection: "connected", info: { environmentId: "env-1", name: "studio", version: "1", startedAt: 1 } } },
      primaryId: "env-1",
    });
    const rpc = mockRpc({ "thread.terminalCommand": () => ({ command: "claude --resume abc" }) });
    mountHeader();
    await act(async () => {
      fireEvent.focus(window);
    });
    expect(rpc).not.toHaveBeenCalledWith("server.info", expect.anything());
  });
});
