import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** True when an `openssl` binary can be run (the TLS tests that need a certificate skip without it). */
export function hasOpenssl(): boolean {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export interface SelfSigned {
  dir: string;
  certPath: string;
  keyPath: string;
  cert: string;
  key: string;
  remove(): void;
}

/** A throwaway P-256 self-signed pair in a temp dir. `san` defaults to localhost + 127.0.0.1. */
export function selfSigned(san = "DNS:localhost,IP:127.0.0.1", cn = "localhost"): SelfSigned {
  const dir = mkdtempSync(join(tmpdir(), "tide-tls-"));
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "2", "-subj", `/CN=${cn}`, "-addext", `subjectAltName=${san}`, "-keyout", keyPath, "-out", certPath],
    { stdio: "ignore" },
  );
  return { dir, certPath, keyPath, cert: readFileSync(certPath, "utf8"), key: readFileSync(keyPath, "utf8"), remove: () => rmSync(dir, { recursive: true, force: true }) };
}
