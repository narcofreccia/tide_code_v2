import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEnvironments } from "../../state/environments.ts";
import { RelayPanel } from "./RelayPanel.tsx";

afterEach(() => {
  cleanup();
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
});

describe("RelayPanel", () => {
  it("shows the relay form to the owner", () => {
    useEnvironments.setState({ environments: [{ id: "env-1", name: "box", routes: [], addedAt: 0 }], primaryId: "env-1" });
    render(<RelayPanel info={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Relay/ }));
    expect(screen.getByRole("form", { name: "Relay settings" })).toBeDefined();
  });

  it("hides it on a paired device, which the server refuses relay changes from", () => {
    useEnvironments.setState({ environments: [{ id: "env-1", name: "box", routes: [], addedAt: 0, clientId: "c-phone" }], primaryId: "env-1" });
    render(<RelayPanel info={undefined} />);
    fireEvent.click(screen.getByRole("button", { name: /Relay/ }));
    expect(screen.queryByRole("form", { name: "Relay settings" })).toBeNull();
    expect(screen.getByText("Only the owner of this machine can change its relay.")).toBeDefined();
  });
});
