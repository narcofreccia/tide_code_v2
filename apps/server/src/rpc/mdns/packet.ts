/**
 * A minimal DNS message codec for one DNS-SD service: PTR, SRV, TXT, A and AAAA records.
 * Names are written uncompressed and read with compression pointers followed. `parse`
 * never throws: anything malformed comes back as `undefined`.
 */

export const TYPE = { A: 1, PTR: 12, TXT: 16, AAAA: 28, SRV: 33, ANY: 255 } as const;
const CLASS_IN = 1;
/** the top bit of a record's class: "cache flush" (unique records); of a question's class: "unicast reply wanted" */
const TOP_BIT = 0x8000;
const MAX_LABEL = 63;
const MAX_NAME = 255;

export interface Question {
  name: string;
  type: number;
  /** the QU bit: the asker wants a unicast reply */
  unicast: boolean;
}

export interface Srv {
  priority: number;
  weight: number;
  port: number;
  target: string;
}

export interface ResourceRecord {
  name: string;
  type: number;
  ttl: number;
  /** PTR target */
  ptr?: string;
  srv?: Srv;
  txt?: Record<string, string>;
  /** A or AAAA, as text */
  address?: string;
}

export interface Message {
  id: number;
  flags: number;
  questions: Question[];
  answers: ResourceRecord[];
  additionals: ResourceRecord[];
}

export interface ServiceRecords {
  /** the instance label, e.g. "studio-mac-1a2b3c" */
  instance: string;
  /** e.g. "_tide._tcp.local" */
  service: string;
  /** e.g. "tide-1a2b3c.local" */
  host: string;
  port: number;
  ips: string[];
  txt: Record<string, string>;
  ttl: number;
}

const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** Splits a dotted name into labels (an instance label never contains a dot: the responder strips them). */
function labelsOf(name: string): string[] {
  return name.replace(/\.$/, "").split(".").filter((l) => l.length > 0);
}

function encodeName(name: string, out: number[]): void {
  encodeLabels(labelsOf(name), out);
}

function encodeLabels(labels: string[], out: number[]): void {
  let total = 1;
  for (const label of labels) {
    const bytes = utf8.encode(label);
    if (bytes.length > MAX_LABEL) throw new RangeError(`DNS label longer than ${MAX_LABEL} bytes: ${label}`);
    total += bytes.length + 1;
    if (total > MAX_NAME) throw new RangeError("DNS name longer than 255 bytes");
    out.push(bytes.length, ...bytes);
  }
  out.push(0);
}

const u16 = (out: number[], v: number): void => {
  out.push((v >> 8) & 0xff, v & 0xff);
};
const u32 = (out: number[], v: number): void => {
  out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
};

function header(out: number[], id: number, flags: number, counts: [number, number, number, number]): void {
  u16(out, id);
  u16(out, flags);
  for (const c of counts) u16(out, c);
}

/** One PTR (or other type) question for `name`; `unicast` sets the QU bit. */
export function encodeQuery(name: string, type: number, options: { id?: number; unicast?: boolean } = {}): Uint8Array {
  const out: number[] = [];
  header(out, options.id ?? 0, 0, [1, 0, 0, 0]);
  encodeName(name, out);
  u16(out, type);
  u16(out, CLASS_IN | (options.unicast === true ? TOP_BIT : 0));
  return Uint8Array.from(out);
}

function ipv4Bytes(ip: string): number[] | undefined {
  const parts = ip.split(".");
  if (parts.length !== 4) return undefined;
  const bytes = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : -1));
  return bytes.every((b) => b >= 0 && b <= 255) ? bytes : undefined;
}

function ipv6Bytes(ip: string): number[] | undefined {
  const [head = "", tail, extra] = ip.split("::");
  if (extra !== undefined) return undefined;
  const groups = (s: string): string[] => (s === "" ? [] : s.split(":"));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return undefined;
  const all = [...left, ...Array<string>(tail === undefined ? 0 : missing).fill("0"), ...right];
  const out: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return undefined;
    const v = parseInt(g, 16);
    out.push(v >> 8, v & 0xff);
  }
  return out;
}

function record(out: number[], name: string, type: number, ttl: number, flush: boolean, rdata: number[]): void {
  encodeName(name, out);
  u16(out, type);
  u16(out, CLASS_IN | (flush ? TOP_BIT : 0));
  u32(out, ttl);
  u16(out, rdata.length);
  out.push(...rdata);
}

function txtData(txt: Record<string, string>): number[] {
  const out: number[] = [];
  for (const [key, value] of Object.entries(txt)) {
    let bytes = utf8.encode(`${key}=${value}`);
    if (bytes.length > 255) bytes = bytes.slice(0, 255);
    out.push(bytes.length, ...bytes);
  }
  return out.length > 0 ? out : [0];
}

/**
 * A response announcing one instance: PTR in the answers, SRV + TXT + A/AAAA as additionals.
 * `ttl: 0` makes it a goodbye. A legacy unicast reply echoes the query's `id` and `question`.
 */
export function encodeResponse(r: ServiceRecords, options: { id?: number; flush?: boolean; question?: { name: string; type: number } } = {}): Uint8Array {
  const flush = options.flush ?? true;
  const full = `${r.instance}.${r.service}`;
  const additional: number[] = [];
  let count = 0;
  const srv: number[] = [];
  u16(srv, 0);
  u16(srv, 0);
  u16(srv, r.port);
  encodeName(r.host, srv);
  record(additional, full, TYPE.SRV, r.ttl, flush, srv);
  record(additional, full, TYPE.TXT, r.ttl, flush, txtData(r.txt));
  count += 2;
  for (const ip of r.ips) {
    const v4 = ipv4Bytes(ip);
    const v6 = v4 === undefined ? ipv6Bytes(ip) : undefined;
    if (v4 !== undefined) record(additional, r.host, TYPE.A, r.ttl, flush, v4);
    else if (v6 !== undefined) record(additional, r.host, TYPE.AAAA, r.ttl, flush, v6);
    else continue;
    count++;
  }
  const out: number[] = [];
  header(out, options.id ?? 0, 0x8400, [options.question === undefined ? 0 : 1, 1, 0, count]);
  if (options.question !== undefined) {
    encodeName(options.question.name, out);
    u16(out, options.question.type);
    u16(out, CLASS_IN);
  }
  const ptr: number[] = [];
  encodeLabels([r.instance, ...labelsOf(r.service)], ptr);
  record(out, r.service, TYPE.PTR, r.ttl, false, ptr);
  out.push(...additional);
  return Uint8Array.from(out);
}

class Malformed extends Error {}

/** Reads a (possibly compressed) name starting at `start`; returns it and the offset after it. */
function readName(buf: Uint8Array, start: number): [string, number] {
  const labels: string[] = [];
  let offset = start;
  let end = -1;
  let total = 1;
  for (let jumps = 0; ; ) {
    if (offset >= buf.length) throw new Malformed();
    const len = buf[offset] as number;
    if (len === 0) {
      offset++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (offset + 1 >= buf.length || ++jumps > 32) throw new Malformed();
      const target = ((len & 0x3f) << 8) | (buf[offset + 1] as number);
      if (end < 0) end = offset + 2;
      // a pointer must point backwards, which also rules out loops
      if (target >= offset) throw new Malformed();
      offset = target;
      continue;
    }
    if ((len & 0xc0) !== 0 || len > MAX_LABEL) throw new Malformed();
    if (offset + 1 + len > buf.length) throw new Malformed();
    total += len + 1;
    if (total > MAX_NAME) throw new Malformed();
    labels.push(decoder.decode(buf.subarray(offset + 1, offset + 1 + len)));
    offset += 1 + len;
  }
  return [labels.join("."), end < 0 ? offset : end];
}

function readU16(buf: Uint8Array, offset: number): number {
  if (offset + 2 > buf.length) throw new Malformed();
  return ((buf[offset] as number) << 8) | (buf[offset + 1] as number);
}

function readU32(buf: Uint8Array, offset: number): number {
  return readU16(buf, offset) * 0x10000 + readU16(buf, offset + 2);
}

function readTxt(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < data.length; ) {
    const len = data[i] as number;
    if (i + 1 + len > data.length) throw new Malformed();
    const entry = decoder.decode(data.subarray(i + 1, i + 1 + len));
    i += 1 + len;
    if (entry.length === 0) continue;
    const eq = entry.indexOf("=");
    const key = (eq < 0 ? entry : entry.slice(0, eq)).toLowerCase();
    // RFC 6763 §6.4: the first occurrence of a key wins
    if (key.length > 0 && !(key in out)) out[key] = eq < 0 ? "" : entry.slice(eq + 1);
  }
  return out;
}

function ipv6Text(data: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((data[i] as number) << 8) | (data[i + 1] as number));
  // RFC 5952: the longest run (≥ 2) of zero groups becomes "::"
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen) [best, bestLen] = [i, j - i];
    i = j;
  }
  const hex = (g: number[]): string => g.map((v) => v.toString(16)).join(":");
  return best < 0 ? hex(groups) : `${hex(groups.slice(0, best))}::${hex(groups.slice(best + bestLen))}`;
}

function readRecord(buf: Uint8Array, start: number): [ResourceRecord, number] {
  const [name, afterName] = readName(buf, start);
  const type = readU16(buf, afterName);
  const ttl = readU32(buf, afterName + 4);
  const length = readU16(buf, afterName + 8);
  const dataStart = afterName + 10;
  const dataEnd = dataStart + length;
  if (dataEnd > buf.length) throw new Malformed();
  const data = buf.subarray(dataStart, dataEnd);
  const rr: ResourceRecord = { name, type, ttl };
  if (type === TYPE.PTR) rr.ptr = readName(buf, dataStart)[0];
  else if (type === TYPE.SRV) {
    if (length < 7) throw new Malformed();
    rr.srv = { priority: readU16(buf, dataStart), weight: readU16(buf, dataStart + 2), port: readU16(buf, dataStart + 4), target: readName(buf, dataStart + 6)[0] };
  } else if (type === TYPE.TXT) rr.txt = readTxt(data);
  else if (type === TYPE.A) {
    if (length !== 4) throw new Malformed();
    rr.address = Array.from(data).join(".");
  } else if (type === TYPE.AAAA) {
    if (length !== 16) throw new Malformed();
    rr.address = ipv6Text(data);
  }
  return [rr, dataEnd];
}

/** Decodes a DNS message; `undefined` for anything truncated or malformed. */
export function parse(input: Uint8Array): Message | undefined {
  try {
    const buf = input;
    if (buf.length < 12) return undefined;
    const id = readU16(buf, 0);
    const flags = readU16(buf, 2);
    const [qd, an, ns, ar] = [readU16(buf, 4), readU16(buf, 6), readU16(buf, 8), readU16(buf, 10)];
    let offset = 12;
    const questions: Question[] = [];
    for (let i = 0; i < qd; i++) {
      const [name, after] = readName(buf, offset);
      const type = readU16(buf, after);
      const cls = readU16(buf, after + 2);
      questions.push({ name, type, unicast: (cls & TOP_BIT) !== 0 });
      offset = after + 4;
    }
    const section = (count: number): ResourceRecord[] => {
      const out: ResourceRecord[] = [];
      for (let i = 0; i < count; i++) {
        const [rr, next] = readRecord(buf, offset);
        out.push(rr);
        offset = next;
      }
      return out;
    };
    const answers = section(an);
    section(ns); // authority records are read past, not kept
    const additionals = section(ar);
    return { id, flags, questions, answers, additionals };
  } catch {
    return undefined;
  }
}

/** DNS names compare case-insensitively. */
export function sameName(a: string, b: string): boolean {
  return a.replace(/\.$/, "").toLowerCase() === b.replace(/\.$/, "").toLowerCase();
}
