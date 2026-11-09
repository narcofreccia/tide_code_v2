import { describe, expect, it } from "vitest";
import { encodeQuery, encodeResponse, parse, TYPE, type ServiceRecords } from "./packet.ts";

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const label = (s: string): number[] => [s.length, ...ascii(s)];

const RECORDS: ServiceRecords = {
  instance: "Studio Mac-1a2b3c",
  service: "_tide._tcp.local",
  host: "tide-1a2b3c.local",
  port: 3777,
  ips: ["192.168.1.42", "fe80::1:2"],
  ttl: 120,
  txt: { envId: "env-1a2b3c", name: "Studio Mac", version: "0.9.0", protocol: "1", port: "3777" },
};

describe("mdns packet", () => {
  it("encodes the PTR query a browser sends, byte for byte", () => {
    const bytes = Array.from(encodeQuery("_tide._tcp.local", TYPE.PTR));
    expect(bytes).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...label("_tide"), ...label("_tcp"), ...label("local"), 0, 0, 12, 0, 1]);
    expect(parse(Uint8Array.from(bytes))).toEqual({ id: 0, flags: 0, questions: [{ name: "_tide._tcp.local", type: TYPE.PTR, unicast: false }], answers: [], additionals: [] });
  });

  it("reads a hand-written query whose second name is a compression pointer", () => {
    const bytes = Uint8Array.from([
      0x12, 0x34, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0,
      // offset 12: _tide._tcp.local PTR IN
      ...label("_tide"), ...label("_tcp"), ...label("local"), 0, 0, 12, 0, 1,
      // _other + pointer to "_tcp.local" (offset 18), PTR, QU bit set
      ...label("_other"), 0xc0, 18, 0, 12, 0x80, 1,
      // a bare pointer to the first name, SRV
      0xc0, 12, 0, 33, 0, 1,
    ]);
    expect(parse(bytes)?.questions).toEqual([
      { name: "_tide._tcp.local", type: TYPE.PTR, unicast: false },
      { name: "_other._tcp.local", type: TYPE.PTR, unicast: true },
      { name: "_tide._tcp.local", type: TYPE.SRV, unicast: false },
    ]);
    expect(parse(bytes)?.id).toBe(0x1234);
  });

  it("round-trips a response: PTR answer, SRV + TXT + A + AAAA additionals", () => {
    const message = parse(encodeResponse(RECORDS, { id: 7 }));
    expect(message?.id).toBe(7);
    expect(message?.flags).toBe(0x8400);
    expect(message?.answers).toEqual([{ name: "_tide._tcp.local", type: TYPE.PTR, ttl: 120, ptr: "Studio Mac-1a2b3c._tide._tcp.local" }]);
    const byType = (type: number) => message?.additionals.filter((r) => r.type === type);
    expect(byType(TYPE.SRV)).toEqual([{ name: "Studio Mac-1a2b3c._tide._tcp.local", type: TYPE.SRV, ttl: 120, srv: { priority: 0, weight: 0, port: 3777, target: "tide-1a2b3c.local" } }]);
    // TXT keys are case-insensitive (RFC 6763 §6.4), so they come back lower-cased
    expect(byType(TYPE.TXT)?.[0]?.txt).toEqual({ envid: "env-1a2b3c", name: "Studio Mac", version: "0.9.0", protocol: "1", port: "3777" });
    expect(byType(TYPE.A)?.[0]?.address).toBe("192.168.1.42");
    expect(byType(TYPE.AAAA)?.[0]?.address).toBe("fe80::1:2");
  });

  it("a goodbye carries TTL 0; a legacy reply repeats the question", () => {
    const bye = parse(encodeResponse({ ...RECORDS, ttl: 0 }));
    expect([...(bye?.answers ?? []), ...(bye?.additionals ?? [])].every((r) => r.ttl === 0)).toBe(true);
    const legacy = parse(encodeResponse(RECORDS, { id: 9, question: { name: "_tide._tcp.local", type: TYPE.PTR } }));
    expect(legacy?.questions).toEqual([{ name: "_tide._tcp.local", type: TYPE.PTR, unicast: false }]);
  });

  it("refuses to encode a label over 63 bytes", () => {
    expect(() => encodeQuery(`${"x".repeat(64)}.local`, TYPE.A)).toThrow(RangeError);
  });

  it("returns undefined for malformed input, never throws", () => {
    const query = encodeQuery("_tide._tcp.local", TYPE.PTR);
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      query.subarray(0, 11),
      // truncated mid-name and mid-question
      query.subarray(0, 20),
      query.subarray(0, query.length - 1),
      // a pointer to itself, and one pointing forward
      Uint8Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 12, 0, 12, 0, 1]),
      Uint8Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0xc0, 20, 0, 12, 0, 1, 0, 0]),
      // reserved label type (0x40) — a "length" over 63
      Uint8Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x40, ...new Array<number>(64).fill(0x61), 0, 0, 1, 0, 1]),
      // a name over 255 bytes
      Uint8Array.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, ...Array.from({ length: 5 }, () => label("y".repeat(60))).flat(), 0, 0, 1, 0, 1]),
      // more answers announced than present
      Uint8Array.from([0, 0, 0x84, 0, 0, 0, 0, 2, 0, 0, 0, 0]),
      // an A record whose rdlength runs past the end
      Uint8Array.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 9, 1, 2]),
    ];
    for (const bytes of cases) expect(parse(bytes)).toBeUndefined();
    let seed = 1;
    const rand = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff;
    // garbage must never throw (it may still decode)
    for (let i = 0; i < 500; i++) expect(() => parse(Uint8Array.from({ length: 12 + (i % 80) }, rand))).not.toThrow();
  });
});
