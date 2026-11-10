import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkServerIdentity, rootCertificates, type PeerCertificate } from "node:tls";
import type { ClientOptions } from "ws";

/**
 * R19: when the Tide server listens with TLS it hands its certificate path in TIDE_SERVER_CA and
 * this child dials it back over wss on loopback. The certificate is trusted next to the public
 * roots (a self-signed pair works, verification stays on); a certificate issued for a DNS name
 * does not name 127.0.0.1, so the hostname check also accepts that exact certificate, pinned by
 * its SHA-256 fingerprint. Same rule as apps/server/src/loopback.ts.
 */
export async function trustedWebSocket(caPath: string): Promise<typeof WebSocket> {
  const pem = readFileSync(caPath, "utf8");
  const ca = [...rootCertificates, pem];
  const pinned = new X509Certificate(pem).fingerprint256;
  if ("Bun" in globalThis) {
    // Bun's WebSocket takes TLS options as its second argument (it checks the chain, not the name)
    const Native = globalThis.WebSocket;
    const options = { tls: { ca } } as unknown as string[];
    return class extends Native {
      constructor(url: string | URL) {
        super(url, options);
      }
    } as typeof WebSocket;
  }
  // Node's built-in WebSocket has no TLS options: the `ws` client mirrors the browser API
  const { WebSocket: WsClient } = await import("ws");
  // ws types checkServerIdentity with its own signature; node's tls.connect is what calls it
  const raw: Record<string, unknown> = { ca, checkServerIdentity: (host: string, cert: PeerCertificate) => (cert.fingerprint256 === pinned ? undefined : checkServerIdentity(host, cert)) };
  const tls = raw as ClientOptions;
  return class extends WsClient {
    constructor(url: string | URL) {
      super(url, tls);
    }
  } as unknown as typeof WebSocket;
}
