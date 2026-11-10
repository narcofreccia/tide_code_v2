import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { NetworkInterfaceInfo } from "node:os";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, resolveConfig, type ServerConfig } from "../config.ts";
import { openDatabase } from "../db/sqlite.ts";
import { loopbackFetch, loopbackTrust, wsTlsOptions, type LoopbackTrust } from "../loopback.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { pairingUrls } from "./env.ts";
import { buildRemoteInfo, landingPage, pairPage } from "./remote.ts";
import { startServer, type ServerHandle } from "./server.ts";
import { hasOpenssl, selfSigned, type SelfSigned } from "./testing/selfSigned.ts";
import { readTlsFiles } from "./tls.ts";

const OPENSSL = hasOpenssl();
const v4 = (address: string): NetworkInterfaceInfo =>
  ({ address, netmask: "255.255.255.0", family: "IPv4", mac: "00:00:00:00:00:00", internal: false, cidr: `${address}/24` }) as NetworkInterfaceInfo;

describe("scheme of the URLs this server hands out", () => {
  it("wss/https when the server listens with TLS, ws/http otherwise", () => {
    const interfaces = { en0: [v4("192.168.1.42")] };
    const plain = buildRemoteInfo({ host: "0.0.0.0", port: 3777, token: "t", includePairing: true, interfaces });
    expect(plain.lanUrls).toEqual(["ws://192.168.1.42:3777/ws"]);
    expect(plain.pairingUrl).toBe("http://192.168.1.42:3777/pair#token=t");
    expect(plain.tls).toBeUndefined();
    const tls = buildRemoteInfo({ host: "0.0.0.0", port: 3777, token: "t", includePairing: true, interfaces, tls: true });
    expect(tls.lanUrls).toEqual(["wss://192.168.1.42:3777/ws"]);
    expect(tls.pairingUrl).toBe("https://192.168.1.42:3777/pair#token=t");
    expect(tls.tls).toBe(true);
    expect(pairingUrls(tls, undefined)).toEqual(["https://192.168.1.42:3777"]);
    expect(pairingUrls(plain, undefined)).toEqual(["http://192.168.1.42:3777"]);
  });

  it("falls back to loopback with the right scheme and says so on the help pages", () => {
    const loop = buildRemoteInfo({ host: "127.0.0.1", port: 3777, token: "t", includePairing: false, tls: true });
    expect(pairingUrls(loop, undefined)).toEqual(["https://127.0.0.1:3777"]);
    expect(pairPage(loop)).toContain("wss://127.0.0.1:3777/ws");
    expect(landingPage({ name: "box", version: "1", port: 3777, tls: true })).toContain("https://&lt;this-host&gt;:3777");
    expect(landingPage({ name: "box", version: "1", port: 3777 })).toContain("http://&lt;this-host&gt;:3777");
  });
});

describe("TLS configuration", () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
  const home = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "tide-tls-home-"));
    dirs.push(dir);
    return dir;
  };

  it("is off when neither path is given", () => {
    expect(readTlsFiles(undefined, undefined)).toBeUndefined();
    expect(readTlsFiles("", " ")).toBeUndefined();
    expect(resolveConfig(["--data", ":memory:"], { TIDE_HOME: home() }, { probeWeb: false }).tls).toBeUndefined();
  });

  it("needs both paths: one alone stops the server with one sentence", () => {
    expect(() => resolveConfig(["--data", ":memory:", "--tls-cert", "/x/cert.pem"], { TIDE_HOME: home() }, { probeWeb: false })).toThrow(ConfigError);
    expect(() => resolveConfig(["--data", ":memory:"], { TIDE_HOME: home(), TIDE_TLS_KEY: "/x/key.pem" }, { probeWeb: false })).toThrow(/both a certificate and its key/);
  });

  it("refuses an unreadable file or a file that is not PEM, naming the path and never the content", () => {
    const dir = home();
    const junk = join(dir, "junk.pem");
    writeFileSync(junk, "not a certificate\n");
    expect(() => readTlsFiles(join(dir, "missing.pem"), junk)).toThrow(/certificate file .*missing\.pem cannot be read \(ENOENT\)/);
    expect(() => readTlsFiles(junk, junk)).toThrow(/does not hold a PEM certificate/);
  });

  describe.skipIf(!OPENSSL)("with a generated certificate (needs openssl)", () => {
    let a: SelfSigned;
    let b: SelfSigned;
    beforeAll(() => {
      a = selfSigned();
      b = selfSigned();
    });
    afterAll(() => {
      a.remove();
      b.remove();
    });

    it("loads a valid pair from flags or from the environment (flags win)", () => {
      const fromEnv = resolveConfig(["--data", ":memory:"], { TIDE_HOME: home(), TIDE_TLS_CERT: a.certPath, TIDE_TLS_KEY: a.keyPath }, { probeWeb: false });
      expect(fromEnv.tls).toMatchObject({ certPath: a.certPath, keyPath: a.keyPath, cert: a.cert, key: a.key });
      const fromFlags = resolveConfig(["--data", ":memory:", "--tls-cert", b.certPath, "--tls-key", b.keyPath], { TIDE_HOME: home(), TIDE_TLS_CERT: a.certPath, TIDE_TLS_KEY: a.keyPath }, { probeWeb: false });
      expect(fromFlags.tls?.certPath).toBe(b.certPath);
    });

    it("refuses a key that is not the certificate's, a key file without a key, and an expired certificate", () => {
      expect(() => readTlsFiles(a.certPath, b.keyPath)).toThrow(/does not belong to the certificate/);
      expect(() => readTlsFiles(a.certPath, a.certPath)).toThrow(/does not hold a PEM private key/);
      expect(() => readTlsFiles(a.certPath, a.keyPath, Date.now() + 10 * 24 * 3600_000)).toThrow(/expired on/);
      try {
        readTlsFiles(a.certPath, b.keyPath);
      } catch (err) {
        expect(String(err)).not.toContain("PRIVATE KEY");
      }
    });
  });
});

describe.skipIf(!OPENSSL)("HTTPS listener (needs openssl)", () => {
  let pair: SelfSigned;
  let other: SelfSigned;
  let handle: ServerHandle;
  let store: EventStore;
  let trust: LoopbackTrust;
  const TOKEN = "tls-test-token";

  beforeAll(async () => {
    pair = selfSigned();
    other = selfSigned();
    trust = loopbackTrust(pair.cert);
    store = new EventStore(await openDatabase(":memory:"));
    const config: ServerConfig = {
      tideHome: "/tmp/tide-tls-test",
      dataDir: ":memory:",
      dbPath: ":memory:",
      environmentId: "env-tls",
      token: TOKEN,
      host: "127.0.0.1",
      port: 0,
      dev: true,
      printToken: false,
      corsOrigins: [],
      version: "1.2.3",
      providers: {},
      tls: { certPath: pair.certPath, keyPath: pair.keyPath, cert: pair.cert, key: pair.key },
    };
    handle = await startServer({ engine: new Engine({ store }), store, config });
  });
  afterAll(async () => {
    await handle.close();
    store.close();
    pair.remove();
    other.remove();
  });

  it("answers /health over https and reports a wss url", async () => {
    expect(handle.url).toBe(`wss://127.0.0.1:${handle.port}/ws`);
    const res = await loopbackFetch(trust)(`https://127.0.0.1:${handle.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, environmentId: "env-tls" });
  });

  it("does not speak plain HTTP on the same port, and an untrusted certificate is refused", async () => {
    await expect(fetch(`http://127.0.0.1:${handle.port}/health`)).rejects.toThrow();
    await expect(loopbackFetch(loopbackTrust(other.cert))(`https://127.0.0.1:${handle.port}/health`)).rejects.toThrow();
  });

  it("upgrades a WSS connection and serves RPC on it", async () => {
    const ws = new WebSocket(`wss://127.0.0.1:${handle.port}/ws?token=${TOKEN}`, wsTlsOptions(trust));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    const reply = new Promise<{ id: string; result?: { remote?: { tls?: boolean; port: number } } }>((resolve) => {
      ws.on("message", (data) => {
        const frame = JSON.parse(data.toString()) as { id?: string; result?: { remote?: { tls?: boolean; port: number } } };
        if (frame.id === "1") resolve(frame as { id: string; result?: { remote?: { tls?: boolean; port: number } } });
      });
    });
    ws.send(JSON.stringify({ id: "1", method: "server.info", params: {} }));
    const frame = await reply;
    expect(frame.result?.remote).toMatchObject({ tls: true, port: handle.port });
    ws.close();
  });
});
