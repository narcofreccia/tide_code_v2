import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DeviceAccess, PairedClient } from "@tide/contracts";
import { safeEqual } from "./pairing.ts";

/** at most one `lastSeenAt` write to disk per client per minute */
export const TOUCH_WRITE_INTERVAL_MS = 60_000;
/** R18: at most one `lastUsedAt` write to disk per token per hour */
export const USE_WRITE_INTERVAL_MS = 60 * 60_000;
/** R18: a device token nobody used for this long is rejected and dropped */
export const TOKEN_IDLE_EXPIRY_MS = 90 * 24 * 60 * 60_000;

interface StoredClient extends PairedClient {
  /** sha256 hex of the token; the token itself is never stored */
  hash: string;
  scope?: "mcp";
  /** R18: last ticket purchase with this token (absent in files written before R18) */
  lastUsedAt?: number;
}

/** The newest sign of life: a ticket purchase, an open socket, or the pairing itself. */
const lastActivity = (c: StoredClient): number => Math.max(c.createdAt, c.lastSeenAt ?? 0, c.lastUsedAt ?? 0);

interface StoredFile {
  version: 1;
  clients: StoredClient[];
}

export interface ClientTokenStoreOptions {
  /** `<dir>/clients.json`; omitted = in memory only (tests, `--data :memory:`) */
  path?: string;
  now?: () => number;
  random?: (bytes: number) => Buffer;
  log?: (msg: string, data?: unknown) => void;
}

const hashOf = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");

function isStored(value: unknown): value is StoredClient {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["createdAt"] === "number" &&
    typeof v["hash"] === "string" &&
    /^[0-9a-f]{64}$/.test(v["hash"]) &&
    (v["scope"] === undefined || v["scope"] === "mcp") &&
    (v["lastUsedAt"] === undefined || typeof v["lastUsedAt"] === "number") &&
    (v["access"] === undefined || v["access"] === "limited" || v["access"] === "full")
  );
}

/**
 * R17: one bearer token per paired device, so a lost phone can be revoked without rotating the
 * master token in server.json. Persisted (0600) as sha256 hashes in `<TIDE_HOME>/clients.json`.
 */
export class ClientTokenStore {
  #path: string | undefined;
  #now: () => number;
  #random: (bytes: number) => Buffer;
  #log: (msg: string, data?: unknown) => void;
  #clients: StoredClient[];
  /** last time each client's `lastSeenAt` reached the disk */
  #touchWritten = new Map<string, number>();
  /** last time each client's `lastUsedAt` reached the disk */
  #useWritten = new Map<string, number>();
  #dirty = false;

  /** clients.json lives beside settings.json (so a `--data` scratch run never touches ~/.tide). */
  static pathFor(settingsPath: string): string {
    return join(dirname(settingsPath), "clients.json");
  }

  constructor(options: ClientTokenStoreOptions = {}) {
    this.#path = options.path;
    this.#now = options.now ?? (() => Date.now());
    this.#random = options.random ?? ((n) => randomBytes(n));
    this.#log = options.log ?? ((msg, data) => (data === undefined ? console.error(msg) : console.error(msg, data)));
    this.#clients = this.#load();
    if (this.#dropExpired() > 0) this.#save();
  }

  /** R19: new devices are `limited` unless the code they redeemed said otherwise */
  mint(name: string, address: string, access: DeviceAccess = "limited", scope?: "mcp"): { id: string; token: string } {
    let id: string;
    do id = this.#random(9).toString("base64url");
    while (this.has(id));
    const token = this.#random(32).toString("base64url");
    const now = this.#now();
    this.#clients.push({ id, name, createdAt: now, lastSeenAt: now, lastAddress: address, access, ...(scope === undefined ? {} : { scope }), hash: hashOf(token) });
    this.#touchWritten.set(id, now);
    this.#save();
    return { id, token };
  }

  /**
   * The client id for a live token. Compares against every hash so timing does not say which one
   * was close. A token idle for TOKEN_IDLE_EXPIRY_MS is dropped here too (a server that runs for months).
   */
  resolve(token: string): string | undefined {
    if (this.#dropExpired() > 0) this.#save();
    const hash = hashOf(token);
    let match: string | undefined;
    for (const client of this.#clients) if (safeEqual(client.hash, hash)) match = client.id;
    return match;
  }

  has(id: string): boolean {
    return this.#clients.some((c) => c.id === id);
  }

  /**
   * R19: the device's level, read on every call so a change reaches open sockets. Rows written
   * before R19 carry no level and keep the full powers they had; undefined = no such device.
   */
  accessOf(id: string): DeviceAccess | undefined {
    const client = this.#clients.find((c) => c.id === id);
    return client === undefined ? undefined : (client.access ?? "full");
  }

  /** R19: false = no such device. */
  setAccess(id: string, access: DeviceAccess): boolean {
    const client = this.#clients.find((c) => c.id === id);
    if (!client) return false;
    client.access = access;
    this.#save();
    return true;
  }

  isMcpOnly(id: string): boolean {
    return this.#clients.find((c) => c.id === id)?.scope === "mcp";
  }

  touch(id: string, address: string): void {
    const client = this.#clients.find((c) => c.id === id);
    if (!client) return;
    const now = this.#now();
    client.lastSeenAt = now;
    client.lastAddress = address;
    const written = this.#touchWritten.get(id);
    if (written !== undefined && now - written < TOUCH_WRITE_INTERVAL_MS) {
      this.#dirty = true;
      return;
    }
    this.#touchWritten.set(id, now);
    this.#save();
  }

  /** R18: a ticket was bought with this client's token; persisted at most once per hour. */
  use(id: string): void {
    const client = this.#clients.find((c) => c.id === id);
    if (!client) return;
    const now = this.#now();
    client.lastUsedAt = now;
    const written = this.#useWritten.get(id);
    if (written !== undefined && now - written < USE_WRITE_INTERVAL_MS) {
      this.#dirty = true;
      return;
    }
    this.#useWritten.set(id, now);
    this.#save();
  }

  list(): PairedClient[] {
    return this.#clients.map(({ hash: _hash, lastUsedAt: _used, scope: _scope, ...client }) => ({ ...client, access: client.access ?? "full" }));
  }

  revoke(id: string): boolean {
    const before = this.#clients.length;
    this.#clients = this.#clients.filter((c) => c.id !== id);
    if (this.#clients.length === before) return false;
    this.#touchWritten.delete(id);
    this.#useWritten.delete(id);
    this.#save();
    return true;
  }

  /** Removes tokens idle for longer than TOKEN_IDLE_EXPIRY_MS; returns how many went. */
  #dropExpired(): number {
    const now = this.#now();
    const live = this.#clients.filter((c) => now - lastActivity(c) < TOKEN_IDLE_EXPIRY_MS);
    const dropped = this.#clients.length - live.length;
    if (dropped > 0) {
      for (const c of this.#clients) if (!live.includes(c)) this.#log(`[clients] device "${c.name}" (${c.id}) unused for 90 days; its token was removed`);
      this.#clients = live;
    }
    return dropped;
  }

  /** Writes touches the debounce held back (server shutdown). */
  flush(): void {
    if (this.#dirty) this.#save();
  }

  #load(): StoredClient[] {
    if (this.#path === undefined) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.#path, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.#log("[clients] unreadable clients.json, no paired devices loaded", err);
      return [];
    }
    const list = typeof raw === "object" && raw !== null ? (raw as { clients?: unknown }).clients : undefined;
    return Array.isArray(list) ? list.filter(isStored) : [];
  }

  #save(): void {
    this.#dirty = false;
    if (this.#path === undefined) return;
    const file: StoredFile = { version: 1, clients: this.#clients };
    try {
      mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
      const tmp = `${this.#path}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmp, this.#path);
    } catch (err) {
      this.#log("[clients] could not persist clients.json", err);
    }
  }
}
