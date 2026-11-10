import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { checkServerIdentity as standardIdentityCheck, rootCertificates, type PeerCertificate } from "node:tls";
import type { ClientOptions } from "ws";

/**
 * R19: how a process on this machine (`tide pair`, `tide doctor`, the home-lock probe, the relay
 * client, the Tide MCP child) calls this server back over loopback when it serves HTTPS. The
 * server's own certificate is the trust anchor, next to the public roots, so a self-signed pair
 * works and verification is never turned off. A certificate issued for a DNS name (Tailscale,
 * Let's Encrypt) does not name 127.0.0.1, so the hostname check also accepts the exact
 * certificate the server was given (pinned by its SHA-256 fingerprint).
 */
export interface LoopbackTrust {
  ca: string[];
  /** the leaf's `AA:BB:…` SHA-256 fingerprint, the format `PeerCertificate.fingerprint256` uses */
  fingerprint256: string;
}

export function loopbackTrust(certPem: string): LoopbackTrust {
  return { ca: [...rootCertificates, certPem], fingerprint256: new X509Certificate(certPem).fingerprint256 };
}

/** The trust for the certificate at `path`, or undefined when there is none or it cannot be read. */
export function trustFromFile(path: string | undefined): LoopbackTrust | undefined {
  if (path === undefined) return undefined;
  try {
    return loopbackTrust(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

export function identityCheck(trust: LoopbackTrust): (host: string, cert: PeerCertificate) => Error | undefined {
  return (host, cert) => (cert.fingerprint256 === trust.fingerprint256 ? undefined : standardIdentityCheck(host, cert));
}

const isBun = "Bun" in globalThis;

/**
 * Options for a `ws` client dialing this server. Node's `ws` hands `ca`/`checkServerIdentity` to
 * `tls.connect`; Bun replaces the `ws` module with its own client, which reads `tls.ca` and checks
 * the chain against it (it has no hostname hook, so there the anchor alone decides).
 */
export function wsTlsOptions(trust: LoopbackTrust | undefined): ClientOptions {
  if (trust === undefined) return {};
  // ws types checkServerIdentity with its own signature; node's tls.connect is what calls it
  const options: Record<string, unknown> = { ca: trust.ca, checkServerIdentity: identityCheck(trust), tls: { ca: trust.ca } };
  return options as ClientOptions;
}

export type LoopbackFetch = (url: string, init?: RequestInit) => Promise<Response>;

const NO_BODY: ReadonlySet<number> = new Set([101, 204, 205, 304]);

function nodeHttps(trust: LoopbackTrust, url: string, init: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {};
  new Headers(init.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const body = init.body;
  const payload = typeof body === "string" || body instanceof Uint8Array ? body : undefined;
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      url,
      { method: init.method ?? "GET", headers, ca: trust.ca, checkServerIdentity: identityCheck(trust), ...(init.signal ? { signal: init.signal } : {}) },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const out = new Headers();
          for (const [key, value] of Object.entries(res.headers)) {
            if (value === undefined) continue;
            for (const v of Array.isArray(value) ? value : [value]) out.append(key, v);
          }
          const status = res.statusCode ?? 502;
          resolve(new Response(NO_BODY.has(status) ? null : Buffer.concat(chunks), { status, headers: out }));
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/**
 * `fetch` for loopback calls to this server: unchanged for `http://` (or without a certificate);
 * for `https://` the server's certificate is trusted as above. Bun's fetch takes the TLS options
 * itself; Node's has no such hook, so the request goes through `node:https`.
 */
export function loopbackFetch(trust: LoopbackTrust | undefined): LoopbackFetch {
  return (url, init = {}) => {
    if (trust === undefined || !url.startsWith("https:")) return fetch(url, init);
    if (isBun) return fetch(url, { ...init, tls: { ca: trust.ca, checkServerIdentity: identityCheck(trust) } } as RequestInit);
    return nodeHttps(trust, url, init);
  };
}
