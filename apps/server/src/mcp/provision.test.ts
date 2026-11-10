import { describe, expect, it } from "vitest";
import { AgentTokenStore } from "../rpc/agentTickets.ts";
import { TideMcpProvisioner } from "./provision.ts";

describe("TideMcpProvisioner", () => {
  const entry = { command: "tide", args: ["--mcp"] };

  it("attaches nothing until the server URL is known, then the thread's token", () => {
    const mcp = new TideMcpProvisioner({ tokens: new AgentTokenStore(), entry });
    expect(mcp.serversFor("t1")).toEqual([]);
    mcp.setUrl("ws://127.0.0.1:3777/ws");
    const [spec] = mcp.serversFor("t1");
    expect(spec?.env).toMatchObject({ TIDE_SERVER_URL: "ws://127.0.0.1:3777/ws", TIDE_THREAD_ID: "t1" });
    expect(spec?.env).not.toHaveProperty("TIDE_SERVER_CA");
  });

  it("hands the certificate path to the child when the server listens with TLS (R19)", () => {
    const mcp = new TideMcpProvisioner({ tokens: new AgentTokenStore(), entry });
    mcp.setUrl("wss://127.0.0.1:3777/ws", "/etc/tide/cert.pem");
    expect(mcp.serversFor("t1")[0]?.env).toMatchObject({ TIDE_SERVER_URL: "wss://127.0.0.1:3777/ws", TIDE_SERVER_CA: "/etc/tide/cert.pem" });
  });
});
