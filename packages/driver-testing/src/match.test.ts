import { describe, expect, it } from "vitest";
import { matchFrame, substituteId } from "./match.ts";

describe("matchFrame", () => {
  it("matches a JSON subset and ignores extra keys", () => {
    expect(matchFrame({ method: "turn/start", params: { threadId: "t1" } }, { jsonrpc: "2.0", id: 3, method: "turn/start", params: { threadId: "t1", cwd: "/x" } }).ok).toBe(true);
  });

  it("reports every mismatch with its path", () => {
    const result = matchFrame({ method: "turn/start", params: { threadId: "t1", input: [{ type: "text" }] } }, { method: "turn/steer", params: { threadId: "t2", input: [{ type: "image" }] } });
    expect(result.ok).toBe(false);
    expect(result.mismatches).toEqual([
      '$.method: expected "turn/start", got "turn/steer"',
      '$.params.threadId: expected "t1", got "t2"',
      '$.params.input[0].type: expected "text", got "image"',
    ]);
  });

  it("flags a missing key and a wrong array length", () => {
    const result = matchFrame({ a: 1, list: [1, 2] }, { list: [1] });
    expect(result.mismatches).toEqual(["$.a: missing (expected 1)", "$.list: expected 2 element(s), got 1"]);
  });

  it("treats /re/flags strings as regexes and $any as a wildcard", () => {
    expect(matchFrame({ id: "$any", text: "/^# Context handoff/" }, { id: 7, text: "# Context handoff: history" }).ok).toBe(true);
    expect(matchFrame({ text: "/^hello$/i" }, { text: "HELLO" }).ok).toBe(true);
    expect(matchFrame({ text: "/^hello$/" }, { text: "hello there" }).ok).toBe(false);
    expect(matchFrame({ id: "$any" }, {}).ok).toBe(false);
  });

  it("matches literal strings exactly (a slash inside is not a regex)", () => {
    expect(matchFrame({ path: "/api/session" }, { path: "/api/session" }).ok).toBe(true);
    expect(matchFrame({ path: "/api/session" }, { path: "/api/session/x" }).ok).toBe(false);
  });

  it("supports a top-level string pattern over the serialised frame", () => {
    expect(matchFrame('"method":"initialized"', { jsonrpc: "2.0", method: "initialized" }).ok).toBe(true);
    expect(matchFrame("/turn\\/(start|steer)/", { method: "turn/steer" }).ok).toBe(true);
    expect(matchFrame("nope", { method: "x" }).ok).toBe(false);
    expect(matchFrame("plain", "a plain line").ok).toBe(true);
  });
});

describe("substituteId", () => {
  it("replaces $id deeply and keeps its type", () => {
    expect(substituteId({ id: "$id", nested: [{ ref: "$id" }], other: "x" }, 4)).toEqual({ id: 4, nested: [{ ref: 4 }], other: "x" });
  });
});
