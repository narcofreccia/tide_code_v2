import { describe, expect, it } from "vitest";
import { cleanHeaders, decodeData, encodeData, parseControl, sendableCode, toBuffer } from "./protocol.ts";

describe("protocol", () => {
  it("round-trips a data frame with its channel and text/binary flag", () => {
    const frame = encodeData(70000, Buffer.from("hi"), true);
    expect(decodeData(frame)).toEqual({ channel: 70000, binary: true, payload: Buffer.from("hi") });
    expect(decodeData(encodeData(1, Buffer.from("x"), false))?.binary).toBe(false);
    expect(decodeData(Buffer.from([0, 0]))).toBeUndefined();
  });

  it("maps receive-only close codes to sendable ones", () => {
    expect(sendableCode(undefined)).toBe(1000);
    expect(sendableCode(1005)).toBe(1000);
    expect(sendableCode(1006)).toBe(1011);
    expect(sendableCode(4401)).toBe(4401);
    expect(sendableCode(1001)).toBe(1001);
  });

  it("drops hop-by-hop headers and flattens arrays", () => {
    expect(cleanHeaders({ Host: "x", "Content-Length": "3", "X-A": ["1", "2"], "Content-Type": "a/b" }, ["content-type"])).toEqual({ "x-a": "1, 2" });
    expect(cleanHeaders(new Map([["Connection", "close"], ["Etag", "1"]]))).toEqual({ etag: "1" });
  });

  it("parses only well-formed control frames", () => {
    expect(parseControl('{"t":"close","c":1}')).toEqual({ t: "close", c: 1 });
    expect(parseControl("nope")).toBeUndefined();
    expect(parseControl('{"c":1}')).toBeUndefined();
    expect(toBuffer([Buffer.from("a"), Buffer.from("b")]).toString()).toBe("ab");
  });
});
