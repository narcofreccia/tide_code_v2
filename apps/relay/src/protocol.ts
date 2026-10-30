/**
 * Uplink wire format between the relay and one environment (see docs/internals/relay.md).
 * Text frames carry JSON control messages; binary frames carry tunnel data:
 *   [u32 BE channel][u8 kind: 0 = text, 1 = binary][payload…]
 * so a client's frame reaches the environment byte-for-byte with its text/binary flag intact.
 */

export type Headers = Record<string, string>;

/** relay -> environment */
export type DownControl =
  | { t: "open"; c: number; path: string }
  | { t: "close"; c: number; code?: number; reason?: string }
  | { t: "http"; id: number; method: string; path: string; headers: Headers; body?: string };

/** environment -> relay */
export type UpControl =
  | { t: "close"; c: number; code?: number; reason?: string }
  | { t: "res"; id: number; status: number; headers: Headers; body?: string };

export const KIND_TEXT = 0;
export const KIND_BINARY = 1;

export function encodeData(channel: number, payload: Buffer, binary: boolean): Buffer {
  const head = Buffer.allocUnsafe(5);
  head.writeUInt32BE(channel >>> 0, 0);
  head.writeUInt8(binary ? KIND_BINARY : KIND_TEXT, 4);
  return Buffer.concat([head, payload]);
}

export function decodeData(frame: Buffer): { channel: number; binary: boolean; payload: Buffer } | undefined {
  if (frame.length < 5) return undefined;
  return { channel: frame.readUInt32BE(0), binary: frame.readUInt8(4) === KIND_BINARY, payload: frame.subarray(5) };
}

/** `ws` hands messages over as Buffer | ArrayBuffer | Buffer[]. */
export function toBuffer(data: unknown): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data));
}

/** Close codes a peer may legally send; 1005/1006/1015 are receive-only. */
export function sendableCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  if (code === 1000 || code === 1001 || code === 1003 || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)) return code;
  return code === 1005 ? 1000 : 1011;
}

const HOP = new Set(["host", "connection", "keep-alive", "transfer-encoding", "upgrade", "content-length", "proxy-connection", "te", "trailer", "proxy-authorization"]);

/** Flattens node/fetch headers and drops hop-by-hop ones. */
export function cleanHeaders(input: Record<string, string | string[] | undefined> | Iterable<[string, string]>, drop: readonly string[] = []): Headers {
  const out: Headers = {};
  const entries = Symbol.iterator in input ? [...(input as Iterable<[string, string]>)] : Object.entries(input);
  for (const [k, v] of entries) {
    const key = k.toLowerCase();
    if (v === undefined || HOP.has(key) || drop.includes(key)) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  return out;
}

export function parseControl<T>(text: string): T | undefined {
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null && typeof (v as { t?: unknown }).t === "string" ? (v as T) : undefined;
  } catch {
    return undefined;
  }
}
