import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { KnownEnvironment } from "@tide/contracts";
import { useEnvironments } from "../../state/environments.ts";
import { MIXED_CONTENT_REASON, NOT_ENCRYPTED_TIP } from "../../lib/routeSecurity.ts";
import { MachineCard } from "./MachineCard.tsx";
import { NotEncrypted } from "./NotEncrypted.tsx";

afterEach(() => {
  cleanup();
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
});

describe("NotEncrypted (R19)", () => {
  it("labels a plain route to another machine, with the tooltip", () => {
    render(<NotEncrypted url="ws://192.168.1.4:3777/ws" />);
    expect(screen.getByText("Not encrypted").getAttribute("title")).toBe(NOT_ENCRYPTED_TIP);
  });

  it("shows nothing for encrypted, local or missing routes", () => {
    const { container } = render(
      <>
        <NotEncrypted url="wss://box.tail1.ts.net/ws" />
        <NotEncrypted url="ws://127.0.0.1:3777/ws" />
        <NotEncrypted url={undefined} />
      </>,
    );
    expect(container.textContent).toBe("");
  });
});

describe("MachineCard connection security (R19)", () => {
  const mount = (env: KnownEnvironment, error?: string) => {
    useEnvironments.setState({
      environments: [env],
      primaryId: env.id,
      statuses: { [env.id]: error === undefined ? { connection: "connected", route: env.routes[0]! } : { connection: "offline", error } },
    });
    render(<MachineCard env={env} />);
  };

  it("labels a machine reached over plain LAN HTTP", () => {
    mount({ id: "e1", name: "nas", routes: [{ kind: "lan", url: "ws://192.168.1.4:3777/ws", priority: 10 }], addedAt: 0 });
    expect(screen.getByText("Not encrypted")).toBeDefined();
  });

  it("says nothing for a machine reached over wss", () => {
    mount({ id: "e2", name: "nas", routes: [{ kind: "tailscale", url: "wss://nas.tail1.ts.net/ws", priority: 20 }], addedAt: 0 });
    expect(screen.queryByText("Not encrypted")).toBeNull();
  });

  it("shows the mixed content reason when that is why the machine is unreachable", () => {
    mount({ id: "e3", name: "nas", routes: [{ kind: "lan", url: "ws://192.168.1.4:3777/ws", priority: 10 }], addedAt: 0 }, MIXED_CONTENT_REASON);
    expect(screen.getByText(MIXED_CONTENT_REASON)).toBeDefined();
  });
});

describe("Add machine: discovered peers (R19)", () => {
  it("labels a plain peer and not one that serves HTTPS", async () => {
    const { mockRpc } = await import("../../testHarness.ts");
    const { DiscoveredList } = await import("./DiscoveredList.tsx");
    const plain = { environmentId: "env-p", name: "plainbox", version: "1", protocol: 1, host: "192.168.1.30", port: 3777, urls: ["http://192.168.1.30:3777"] };
    const secure = { ...plain, environmentId: "env-s", name: "securebox", urls: ["https://192.168.1.31:3777"], host: "192.168.1.31", tls: true };
    mockRpc({ "env.discover": () => ({ peers: [plain, secure], enabled: true }) });
    render(<DiscoveredList onPick={() => undefined} />);
    expect((await screen.findByRole("button", { name: "Use plainbox" })).textContent).toContain("Not encrypted");
    expect(screen.getByRole("button", { name: "Use securebox" }).textContent).not.toContain("Not encrypted");
  });
});
