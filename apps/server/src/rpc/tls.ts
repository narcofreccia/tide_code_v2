import { createPrivateKey, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { resolve } from "node:path";

/**
 * R19: bring-your-own HTTPS. The server listens with TLS when it is given a certificate and its
 * key (`TIDE_TLS_CERT` / `TIDE_TLS_KEY`, or `tide serve --tls-cert … --tls-key …`); Tide mints no
 * certificates of its own. Without them nothing changes: plain HTTP, as before.
 */
export interface TlsFiles {
  certPath: string;
  keyPath: string;
  /** PEM text; `cert` may carry the chain after the leaf (a fullchain file) */
  cert: string;
  key: string;
}

export const TLS_CERT_ENV = "TIDE_TLS_CERT";
export const TLS_KEY_ENV = "TIDE_TLS_KEY";

function readPem(path: string, what: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
    throw new Error(`the TLS ${what} file ${path} cannot be read (${code})`);
  }
}

/**
 * Reads and checks the pair. Throws one sentence (never key material) when only one path is
 * given, a file cannot be read, a file is not PEM, the key does not belong to the certificate,
 * or the certificate has expired. Returns undefined when neither path is given.
 */
export function readTlsFiles(certPath: string | undefined, keyPath: string | undefined, now: number = Date.now()): TlsFiles | undefined {
  const cert = certPath?.trim() || undefined;
  const key = keyPath?.trim() || undefined;
  if (cert === undefined && key === undefined) return undefined;
  if (cert === undefined || key === undefined) {
    throw new Error(`TLS needs both a certificate and its key: set ${TLS_CERT_ENV} and ${TLS_KEY_ENV} (or --tls-cert and --tls-key) together`);
  }
  const files = { certPath: resolve(cert), keyPath: resolve(key) };
  const certPem = readPem(files.certPath, "certificate");
  const keyPem = readPem(files.keyPath, "key");
  let x509: X509Certificate;
  try {
    x509 = new X509Certificate(certPem);
  } catch {
    throw new Error(`the TLS certificate file ${files.certPath} does not hold a PEM certificate`);
  }
  let privateKey: ReturnType<typeof createPrivateKey>;
  try {
    privateKey = createPrivateKey(keyPem);
  } catch {
    throw new Error(`the TLS key file ${files.keyPath} does not hold a PEM private key (an encrypted key is not supported)`);
  }
  if (!x509.checkPrivateKey(privateKey)) throw new Error(`the TLS key in ${files.keyPath} does not belong to the certificate in ${files.certPath}`);
  if (Date.parse(x509.validTo) < now) throw new Error(`the TLS certificate in ${files.certPath} expired on ${x509.validTo}`);
  return { ...files, cert: certPem, key: keyPem };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * One listener: HTTPS when `tls` is given, plain HTTP otherwise. The https server exposes the same
 * request/upgrade/listen/close surface as the http one, which is all `startServer` uses.
 */
export function createListener(handler: Handler, tls: Pick<TlsFiles, "cert" | "key"> | undefined): Server {
  if (tls === undefined) return createHttpServer(handler);
  return createHttpsServer({ cert: tls.cert, key: tls.key }, handler) as unknown as Server;
}

/** `ws`/`http` → `wss`/`https` when this server listens with TLS. */
export const schemes = (tls: boolean): { http: "http" | "https"; ws: "ws" | "wss" } => (tls ? { http: "https", ws: "wss" } : { http: "http", ws: "ws" });
