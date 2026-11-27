import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEnvironments } from "../../state/environments.ts";
import { mockRpc } from "../../testHarness.ts";
import { makeInfo } from "./testEnvironments.ts";
import { McpPanel } from "./McpPanel.tsx";

afterEach(() => {
  cleanup();
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
  vi.clearAllMocks();
});

describe("McpPanel", () => {
  it("lets the owner generate, reveal, and view remote MCP credentials", async () => {
    useEnvironments.setState({ environments: [{ id: "01TESTENV", name: "mac", routes: [], addedAt: 0 }], primaryId: "01TESTENV" });
    const caller = mockRpc({
      "env.mcpCredentials": () => ({
        environmentId: "01TESTENV",
        token: "mcp-secret-token-value-1234",
        elevationSecret: "elev-hmac-secret-value-9876",
        clientId: "client-mcp-1",
      }),
    });

    render(<McpPanel info={makeInfo("01TESTENV", "mac")} envId="01TESTENV" />);
    fireEvent.click(screen.getByRole("button", { name: /Remote MCP/ }));

    expect(screen.getByTestId("mcp-environment-id").textContent).toBe("01TESTENV");
    fireEvent.click(screen.getByRole("button", { name: "Generate credentials" }));

    const tokenEl = await screen.findByTestId("mcp-bearer-token");
    expect(caller).toHaveBeenCalledWith("env.mcpCredentials", {}, { envId: "01TESTENV" });
    expect(tokenEl.textContent).not.toBe("mcp-secret-token-value-1234");
    expect(screen.getByTestId("mcp-elevation-secret").textContent).not.toBe("elev-hmac-secret-value-9876");

    const showButtons = screen.getAllByRole("button", { name: "Show" });
    fireEvent.click(showButtons[0] as HTMLElement);
    fireEvent.click(showButtons[1] as HTMLElement);
    expect(screen.getByTestId("mcp-bearer-token").textContent).toBe("mcp-secret-token-value-1234");
    expect(screen.getByTestId("mcp-elevation-secret").textContent).toBe("elev-hmac-secret-value-9876");
  });

  it("hides credential generation on a paired device", () => {
    useEnvironments.setState({
      environments: [{ id: "01TESTENV", name: "mac", routes: [], addedAt: 0, clientId: "c-phone" }],
      primaryId: "01TESTENV",
    });

    render(<McpPanel info={makeInfo("01TESTENV", "mac")} envId="01TESTENV" />);
    fireEvent.click(screen.getByRole("button", { name: /Remote MCP/ }));

    expect(screen.queryByRole("button", { name: "Generate credentials" })).toBeNull();
    expect(screen.getByText("Only the owner of this machine can generate remote MCP credentials.")).toBeDefined();
  });
});
