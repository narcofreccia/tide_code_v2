import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientTokenStore, TOKEN_IDLE_EXPIRY_MS, TOUCH_WRITE_INTERVAL_MS, USE_WRITE_INTERVAL_MS } from "./clientTokens.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "tide-clients-"));
  dirs.push(dir);
  return join(dir, "clients.json");
}

/** Deterministic bytes: each call returns a buffer filled with the next counter value. */
function counter(): (n: number) => Buffer {
  let i = 0;
  return (n) => Buffer.alloc(n, ++i);
}

const onDisk = (path: string): { clients: Array<Record<string, unknown>> } => JSON.parse(readFileSync(path, "utf8")) as { clients: Array<Record<string, unknown>> };

describe("ClientTokenStore", () => {
  it("mints, resolves and revokes a device token", () => {
    const store = new ClientTokenStore({ now: () => 1_000, random: counter() });
    const a = store.mint("phone", "10.0.0.5");
    const b = store.mint("laptop", "10.0.0.6");
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    expect(store.resolve(a.token)).toBe(a.id);
    expect(store.resolve(b.token)).toBe(b.id);
    expect(store.resolve("nope")).toBeUndefined();
    expect(store.list()).toEqual([
      { id: a.id, name: "phone", createdAt: 1_000, lastSeenAt: 1_000, lastAddress: "10.0.0.5" },
      { id: b.id, name: "laptop", createdAt: 1_000, lastSeenAt: 1_000, lastAddress: "10.0.0.6" },
    ]);
    expect(store.revoke(a.id)).toBe(true);
    expect(store.revoke(a.id)).toBe(false);
    expect(store.has(a.id)).toBe(false);
    expect(store.resolve(a.token)).toBeUndefined();
    expect(store.resolve(b.token)).toBe(b.id);
  });

  it("persists hashes only (0600) and reloads them", () => {
    const path = scratch();
    const store = new ClientTokenStore({ path, now: () => 5, random: counter() });
    const { id, token } = store.mint("phone", "10.0.0.5");
    const raw = readFileSync(path, "utf8");
    expect(raw).not.toContain(token);
    expect(onDisk(path).clients[0]).toMatchObject({ id, name: "phone", hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);

    const reloaded = new ClientTokenStore({ path, now: () => 5 });
    expect(reloaded.resolve(token)).toBe(id);
    expect(reloaded.list()).toEqual([{ id, name: "phone", createdAt: 5, lastSeenAt: 5, lastAddress: "10.0.0.5" }]);
    expect(reloaded.revoke(id)).toBe(true);
    expect(new ClientTokenStore({ path, now: () => 5 }).list()).toEqual([]);
  });

  it("ignores an unreadable file", () => {
    const logs: string[] = [];
    const store = new ClientTokenStore({ path: join(tmpdir(), "tide-no-such-dir", "clients.json"), log: (m) => logs.push(m) });
    expect(store.list()).toEqual([]);
    expect(logs).toEqual([]); // ENOENT is just "no devices yet"
  });

  it("debounces lastSeenAt writes to one a minute per client; flush writes the rest", () => {
    const path = scratch();
    let now = 0;
    const store = new ClientTokenStore({ path, now: () => now, random: counter() });
    const { id } = store.mint("phone", "a");
    now = 10_000;
    store.touch(id, "b");
    expect(store.list()[0]).toMatchObject({ lastSeenAt: 10_000, lastAddress: "b" }); // memory is current
    expect(onDisk(path).clients[0]).toMatchObject({ lastSeenAt: 0, lastAddress: "a" }); // disk waits
    now = TOUCH_WRITE_INTERVAL_MS;
    store.touch(id, "c");
    expect(onDisk(path).clients[0]).toMatchObject({ lastSeenAt: TOUCH_WRITE_INTERVAL_MS, lastAddress: "c" });
    now += 1;
    store.touch(id, "d");
    expect(onDisk(path).clients[0]).toMatchObject({ lastAddress: "c" });
    store.flush();
    expect(onDisk(path).clients[0]).toMatchObject({ lastSeenAt: TOUCH_WRITE_INTERVAL_MS + 1, lastAddress: "d" });
    store.touch("unknown", "x"); // no-op
  });

  it("puts clients.json beside settings.json", () => {
    expect(ClientTokenStore.pathFor(join("/h", "settings.json"))).toBe(join("/h", "clients.json"));
  });

  it("records lastUsedAt on ticket purchases, writing at most once an hour", () => {
    const path = scratch();
    let now = 1_000;
    const store = new ClientTokenStore({ path, now: () => now, random: counter() });
    const { id } = store.mint("phone", "10.0.0.5");
    store.use(id);
    expect(onDisk(path).clients[0]?.["lastUsedAt"]).toBe(1_000);
    now += USE_WRITE_INTERVAL_MS - 1;
    store.use(id);
    expect(onDisk(path).clients[0]?.["lastUsedAt"]).toBe(1_000); // held back
    now += 1;
    store.use(id);
    expect(onDisk(path).clients[0]?.["lastUsedAt"]).toBe(now);
    // the wire shape stays PairedClient
    expect(Object.keys(store.list()[0] ?? {})).not.toContain("lastUsedAt");
  });

  it("drops tokens unused for 90 days at load and on resolve; old files without lastUsedAt still load", () => {
    const path = scratch();
    const day = 24 * 60 * 60_000;
    const hash = (c: string): string => c.repeat(64);
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        clients: [
          { id: "stale", name: "old phone", createdAt: 0, lastSeenAt: 1 * day, hash: hash("a") },
          { id: "used", name: "laptop", createdAt: 0, lastSeenAt: 1 * day, lastUsedAt: 50 * day, hash: hash("b") },
          { id: "seen", name: "tablet", createdAt: 0, lastSeenAt: 60 * day, hash: hash("c") },
        ],
      }),
    );
    let now = 1 * day + TOKEN_IDLE_EXPIRY_MS;
    const store = new ClientTokenStore({ path, now: () => now, log: () => undefined });
    expect(store.list().map((c) => c.id)).toEqual(["used", "seen"]);
    expect(onDisk(path).clients.map((c) => c["id"])).toEqual(["used", "seen"]);
    now = 50 * day + TOKEN_IDLE_EXPIRY_MS;
    store.resolve("whatever");
    expect(store.list().map((c) => c.id)).toEqual(["seen"]);
  });
});
