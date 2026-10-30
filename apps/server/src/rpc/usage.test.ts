import { describe, expect, it } from "vitest";
import type { RpcFrame, UsageSummary } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { SettingsStore } from "../settings.ts";
import { FIXTURE_HOME, modelWith, OCT_19, OCT_21, thread, turn } from "../usage/testing/fixtures.ts";
import { RpcRouter } from "./router.ts";
import { DEFAULT_WINDOW_MS, registerUsageHandlers } from "./usage.ts";

const AT = Date.parse("2026-10-20T12:00:00Z");

function setup(options: { readHarnessLogs?: boolean } = {}) {
  const model = modelWith([thread("t", { provider: "codex" })], [turn("a", "t", AT, { inputTokens: 10, outputTokens: 5 }, { provider: "codex", model: "gpt-6-luna" })]);
  const engine = { getModel: () => model } as unknown as Engine;
  const settings = new SettingsStore();
  if (options.readHarnessLogs === false) settings.set({ glassBox: { readHarnessLogs: false } });
  const router = new RpcRouter();
  registerUsageHandlers(router, { engine, settings, tideHome: "/tide-home", dataDir: ":memory:", home: FIXTURE_HOME, now: () => OCT_21 });
  const frames: RpcFrame[] = [];
  const connection = router.connection("c", (f) => frames.push(f));
  let seq = 0;
  const call = async (params: unknown): Promise<{ result?: UsageSummary; error?: { code: string } }> => {
    const id = `r${++seq}`;
    await connection.handleRequest(id, "usage.summary", params);
    const frame = frames.find((f) => f.id === id);
    if (frame && "result" in frame) return { result: frame.result as UsageSummary };
    if (frame && "error" in frame) return { error: frame.error };
    throw new Error("no frame");
  };
  return { call };
}

describe("rpc usage.summary", () => {
  it("defaults to the last 30 days and includes external logs", async () => {
    const { call } = setup();
    const { result } = await call({});
    expect(result?.until).toBe(OCT_21);
    expect(result?.since).toBe(OCT_21 - DEFAULT_WINDOW_MS);
    expect(result?.rows.some((r) => r.source === "tide" && r.provider === "codex")).toBe(true);
    expect(result?.rows.some((r) => r.source === "external" && r.provider === "pi")).toBe(true);
  });

  it("rejects an inverted or oversized window with invalid-params", async () => {
    const { call } = setup();
    expect((await call({ since: OCT_21, until: OCT_19 })).error?.code).toBe("invalid-params");
    expect((await call({ since: 0, until: OCT_21 })).error?.code).toBe("invalid-params");
    expect((await call({ since: -5 })).error?.code).toBe("invalid-params");
  });

  it("leaves external rows out when readHarnessLogs is off, and says so", async () => {
    const { call } = setup({ readHarnessLogs: false });
    const { result } = await call({ since: OCT_19, until: OCT_21 });
    expect(result?.rows.every((r) => r.source === "tide")).toBe(true);
    expect(result?.notes.join(" ")).toMatch(/Reading the harnesses' own logs is off/);
  });

  it("honours includeExternal: false", async () => {
    const { call } = setup();
    const { result } = await call({ since: OCT_19, until: OCT_21, includeExternal: false });
    expect(result?.rows.map((r) => r.source)).toEqual(["tide"]);
    expect(result?.notes.join(" ")).toMatch(/not requested/);
  });
});
