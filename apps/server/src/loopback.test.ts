import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { healthEnvironmentId } from "./homeLock.ts";
import { loopbackFetch, loopbackTrust, wsTlsOptions } from "./loopback.ts";
import { hasOpenssl, selfSigned, type SelfSigned } from "./rpc/testing/selfSigned.ts";
import { createListener } from "./rpc/tls.ts";

// a certificate for a DNS name (what Tailscale or Let's Encrypt issue) never names 127.0.0.1:
// local tools still reach the server over loopback because the exact certificate is pinned
describe.skipIf(!hasOpenssl())("loopback calls to a server with a certificate for another name (needs openssl)", () => {
  let named: SelfSigned;
  let stranger: SelfSigned;
  let server: Server;
  let port: number;

  beforeAll(async () => {
    named = selfSigned("DNS:box.example", "box.example");
    stranger = selfSigned("DNS:box.example", "box.example");
    server = createListener((req, res) => {
      res.writeHead(200, { "content-type": "application/json", "x-seen": req.method ?? "" });
      res.end(JSON.stringify({ ok: true, environmentId: "env-pin" }));
    }, named);
    const wss = new WebSocketServer({ noServer: true });
    server.on("upgrade", (req, socket, head) => wss.handleUpgrade(req, socket, head, (ws) => ws.send("hello")));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    named.remove();
    stranger.remove();
  });

  it("fetch: accepts the pinned certificate, refuses another one with the same name", async () => {
    const res = await loopbackFetch(loopbackTrust(named.cert))(`https://127.0.0.1:${port}/health`, { method: "POST", body: "x" });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-seen")).toBe("POST");
    await expect(loopbackFetch(loopbackTrust(stranger.cert))(`https://127.0.0.1:${port}/health`)).rejects.toThrow();
  });

  it("ws: opens with the pinned certificate", async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, wsTlsOptions(loopbackTrust(named.cert)));
    const first = await new Promise<string>((resolve, reject) => {
      ws.once("message", (data) => resolve(data.toString()));
      ws.once("error", reject);
    });
    expect(first).toBe("hello");
    ws.close();
  });

  it("the home-lock probe reads /health over https with the holder's certificate", async () => {
    expect(await healthEnvironmentId(port, 2_000, named.certPath)).toBe("env-pin");
    expect(await healthEnvironmentId(port, 2_000)).toBeUndefined();
  });
});
