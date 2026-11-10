import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { trustedWebSocket } from "./tlsSocket.ts";

function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** a certificate for a DNS name only: the child still reaches 127.0.0.1 because the exact certificate is pinned */
function generate(dir: string): { certPath: string; cert: string; key: string } {
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", "/CN=box.example", "-addext", "subjectAltName=DNS:box.example", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
  return { certPath, cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8") };
}

describe.skipIf(!hasOpenssl())("trustedWebSocket (R19, needs openssl)", () => {
  let dir: string;
  let server: Server;
  let port: number;
  let certPath: string;
  let strangerPath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tide-mcp-tls-"));
    const own = generate(dir);
    certPath = own.certPath;
    const strangerDir = mkdtempSync(join(dir, "other-"));
    strangerPath = generate(strangerDir).certPath;
    server = createServer({ cert: own.cert, key: own.key });
    const wss = new WebSocketServer({ server });
    wss.on("connection", (ws) => ws.send("hello"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    port = typeof address === "object" && address !== null ? address.port : 0;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  const first = (Impl: typeof WebSocket): Promise<string> =>
    new Promise((resolve) => {
      const ws = new Impl(`wss://127.0.0.1:${port}/ws`);
      ws.onmessage = (e) => {
        resolve(String(e.data));
        ws.close();
      };
      ws.onerror = () => resolve("error");
    });

  it("opens with the server's certificate and refuses another one", async () => {
    expect(await first(await trustedWebSocket(certPath))).toBe("hello");
    expect(await first(await trustedWebSocket(strangerPath))).toBe("error");
  });
});
