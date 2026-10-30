import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AcpRegistry, distributionOf, parseRegistry, platformKey, resolveLaunch, toRegistryDto, type AcpAgentEntry } from "./acpRegistry.ts";

const npxAgent: AcpAgentEntry = { id: "gemini", name: "Gemini CLI", distribution: { npx: { package: "@google/gemini-cli@1.0.0", args: ["--experimental-acp"], env: { A: "1" } } } };
const uvxAgent: AcpAgentEntry = { id: "fast", name: "fast-agent", distribution: { uvx: { package: "fast-agent-acp==0.3", args: ["serve"] } } };
const binAgent: AcpAgentEntry = { id: "goose", name: "Goose", distribution: { binary: { "darwin-aarch64": { archive: "https://x/goose.tgz", cmd: "./goose", args: ["acp"] } } } };

const registryJson = (agents: unknown[]) => ({ version: "1.0.0", agents });

describe("ACP registry launch resolution", () => {
  it("maps the platform the registry way", () => {
    expect(platformKey("darwin", "arm64")).toBe("darwin-aarch64");
    expect(platformKey("linux", "x64")).toBe("linux-x86_64");
    expect(platformKey("win32", "x64")).toBe("windows-x86_64");
  });

  it("launches npx agents with -y and their args", () => {
    expect(resolveLaunch(npxAgent)).toEqual({ command: "npx", args: ["-y", "@google/gemini-cli@1.0.0", "--experimental-acp"], env: { A: "1" } });
    expect(distributionOf(npxAgent)).toBe("npx");
  });

  it("launches uvx agents with the package first", () => {
    expect(resolveLaunch(uvxAgent)).toEqual({ command: "uvx", args: ["fast-agent-acp==0.3", "serve"], env: {} });
  });

  it("never downloads a binary: it is reported, not launched", () => {
    expect(distributionOf(binAgent, "darwin-aarch64")).toBe("binary");
    expect(resolveLaunch(binAgent, "darwin-aarch64")).toBeUndefined();
    expect(distributionOf(binAgent, "linux-x86_64")).toBe("none");
    expect(resolveLaunch(binAgent, "linux-x86_64")).toBeUndefined();
  });

  it("keeps only well-formed entries", () => {
    const parsed = parseRegistry(registryJson([npxAgent, { id: "broken" }, { name: "no id", distribution: {} }]));
    expect(parsed.map((a) => a.id)).toEqual(["gemini"]);
    expect(() => parseRegistry({})).toThrow("no agents list");
  });

  it("builds the wire DTO with configured flag and per-machine distribution", () => {
    expect(toRegistryDto({ ...binAgent, repository: "https://github.com/x/goose" }, new Set(["goose"]), "darwin-aarch64")).toEqual({
      id: "goose",
      name: "Goose",
      website: "https://github.com/x/goose",
      distribution: "binary",
      configured: true,
    });
  });

  it("ships a usable bundled snapshot", () => {
    const registry = new AcpRegistry({ dataDir: ":memory:" });
    expect(registry.agents().length).toBeGreaterThan(10);
    expect(registry.fetchedAt).toBeUndefined();
  });
});

describe("AcpRegistry fetch + cache", () => {
  const ok = (body: unknown) => async () => ({ ok: true, status: 200, json: async () => body });
  const offline = async (): Promise<never> => {
    throw new Error("ENOTFOUND");
  };

  it("fetches, caches to disk with a 24 h TTL and serves the cache offline", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tide-acp-"));
    const clock = { t: 1_000 };
    let calls = 0;
    const fetchOnce = async () => {
      calls++;
      return ok(registryJson([npxAgent]))();
    };
    const first = new AcpRegistry({ dataDir, fetch: fetchOnce, now: () => clock.t, snapshot: registryJson([]) });
    expect((await first.load()).map((a) => a.id)).toEqual(["gemini"]);
    expect(first.fetchedAt).toBe(1_000);
    expect(JSON.parse(readFileSync(join(dataDir, "acp-registry.json"), "utf8"))).toMatchObject({ fetchedAt: 1_000 });

    clock.t += 23 * 60 * 60_000;
    await first.load();
    expect(calls).toBe(1);

    // a restarted server offline after the TTL: the disk cache answers
    clock.t += 2 * 60 * 60_000;
    const second = new AcpRegistry({ dataDir, fetch: offline, now: () => clock.t, snapshot: registryJson([]) });
    expect((await second.load()).map((a) => a.id)).toEqual(["gemini"]);
    expect(second.fetchedAt).toBe(1_000);
  });

  it("falls back to the snapshot when offline with no cache, and refetches on demand", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "tide-acp-"));
    writeFileSync(join(dataDir, "acp-registry.json"), "not json");
    const offlineRegistry = new AcpRegistry({ dataDir, fetch: offline, snapshot: registryJson([uvxAgent]) });
    expect((await offlineRegistry.load()).map((a) => a.id)).toEqual(["fast"]);
    const bad = new AcpRegistry({ dataDir: ":memory:", fetch: async () => ({ ok: false, status: 503, json: async () => ({}) }), snapshot: registryJson([uvxAgent]) });
    expect((await bad.load(true)).map((a) => a.id)).toEqual(["fast"]);
    const online = new AcpRegistry({ dataDir: ":memory:", fetch: ok(registryJson([npxAgent, uvxAgent])), snapshot: registryJson([uvxAgent]) });
    expect(online.find("gemini")).toBeUndefined();
    await online.load(true);
    expect(online.find("gemini")?.name).toBe("Gemini CLI");
  });
});
