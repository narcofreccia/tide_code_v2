import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { PROTOCOL_VERSION, type KnownEnvironment, type ServerInfo } from "@tide/contracts";
import { useEnvironments } from "../../state/environments.ts";
import { MachineCard, machineNotes } from "./MachineCard.tsx";

afterEach(() => {
  cleanup();
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
});

const info = (patch: Partial<ServerInfo> & { protocol?: number } = {}): ServerInfo =>
  ({ environmentId: "env-b", name: "build-box", version: "0.9.0", startedAt: 1, ...patch }) as ServerInfo;

const BOX: KnownEnvironment = { id: "env-b", name: "build-box", routes: [], addedAt: 0 };

function mount(other: ServerInfo, primaryVersion = "0.9.0") {
  useEnvironments.setState({
    environments: [{ id: "env-a", name: "laptop", routes: [], addedAt: 0 }, BOX],
    primaryId: "env-a",
    statuses: {
      "env-a": { connection: "connected", info: info({ environmentId: "env-a", name: "laptop", version: primaryVersion }) },
      "env-b": { connection: "connected", info: other },
    },
  });
  render(<MachineCard env={BOX} />);
}

describe("MachineCard version and tool notes", () => {
  it("warns when the machine speaks another protocol", () => {
    mount(info({ version: "1.4.0", protocol: PROTOCOL_VERSION + 1 }));
    expect(screen.getByText("build-box runs Tide 1.4.0 with a different protocol; update it or this app")).toBeDefined();
  });

  it("notes quietly when only the app version differs from the primary's", () => {
    mount(info({ version: "0.9.1", protocol: PROTOCOL_VERSION }), "0.9.0");
    expect(screen.getByText("build-box runs Tide 0.9.1; the primary runs 0.9.0.")).toBeDefined();
    expect(screen.queryByText(/different protocol/)).toBeNull();
  });

  it("says nothing for a server that does not report its protocol and runs the same version", () => {
    mount(info());
    expect(screen.queryAllByRole("note")).toHaveLength(0);
  });

  it("names a missing git and a missing or signed-out gh", () => {
    mount(info({ tools: { git: false, gh: false, rg: true } }));
    expect(screen.getByText("git is not installed on build-box; threads cannot use worktrees.")).toBeDefined();
    expect(screen.getByText(/GitHub CLI \(gh\) is not installed on build-box/)).toBeDefined();
    expect(machineNotes("x", info({ tools: { git: true, gh: true, rg: true, ghAuth: false } }), undefined)).toEqual([
      { tone: "quiet", text: "gh is not logged in on x; run `gh auth login` there for pull requests." },
    ]);
  });
});
