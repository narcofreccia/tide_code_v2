import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { DiscoveredPeer } from "@tide/contracts";
import { useEnvironments } from "../../state/environments.ts";
import { mockRpc } from "../../testHarness.ts";
import { DiscoveredList } from "./DiscoveredList.tsx";

afterEach(() => {
  cleanup();
  useEnvironments.setState({ environments: [], primaryId: undefined });
});

const NAS: DiscoveredPeer = { environmentId: "env-nas", name: "nas", version: "1.4.0", protocol: 1, host: "192.168.1.30", port: 3777, urls: ["http://192.168.1.30:3777"] };
const V6: DiscoveredPeer = { environmentId: "env-v6", name: "lab", version: "1.4.0", protocol: 1, host: "fd00::7", port: 3800, urls: ["http://[fd00::7]:3800"] };

/** Lets the env.discover promise settle. */
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve)).then(() => Promise.resolve());

describe("DiscoveredList", () => {
  it("asks the primary once and lists name · host:port · version; a click hands back the URL", async () => {
    const rpc = mockRpc({ "env.discover": () => ({ peers: [NAS, V6], enabled: true }) });
    const onPick = vi.fn();
    render(<DiscoveredList onPick={onPick} />);
    const nas = await screen.findByRole("button", { name: "Use nas" });
    expect(nas.textContent).toContain("192.168.1.30:3777 · v1.4.0");
    expect(screen.getByRole("button", { name: "Use lab" }).textContent).toContain("[fd00::7]:3800");
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("env.discover", {});
    fireEvent.click(nas);
    expect(onPick).toHaveBeenCalledWith("http://192.168.1.30:3777");
  });

  it("leaves out machines this window already knows", async () => {
    useEnvironments.setState({ environments: [{ id: "env-nas", name: "nas", routes: [], addedAt: 0 }] });
    mockRpc({ "env.discover": () => ({ peers: [NAS, V6], enabled: true }) });
    render(<DiscoveredList onPick={() => undefined} />);
    await screen.findByRole("button", { name: "Use lab" });
    expect(screen.queryByRole("button", { name: "Use nas" })).toBeNull();
  });

  it.each([
    ["no peers", () => ({ peers: [], enabled: true })],
    ["discovery off on that host", () => ({ peers: [NAS], enabled: false })],
    [
      "an older server without env.discover",
      () => {
        throw Object.assign(new Error("unknown method"), { code: "method-not-found" });
      },
    ],
  ])("renders nothing for %s", async (_label, handler) => {
    const rpc = mockRpc({ "env.discover": handler });
    const { container } = render(<DiscoveredList onPick={() => undefined} />);
    expect(rpc).toHaveBeenCalled();
    await act(async () => {
      await Promise.allSettled([rpc.mock.results[0]?.value]);
      await settle();
    });
    expect(container.innerHTML).toBe("");
    expect(screen.queryByText("Found on your network")).toBeNull();
  });
});
