import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProviderSession } from "@tide/contracts";
import { createPiInstance, OLLAMA_TAGS_URL } from "../src/index.ts";
import { sessionFileGone } from "../src/bridge.ts";
import type { PiEntry } from "../src/turns.ts";
import { baseScript, fakePi, type FakePi } from "./fake-pi.ts";
import { collect, env, options } from "./harness.ts";

type Reporting = ProviderSession & { readonly resumeFailed?: string | undefined };

function instanceWith(bridgePath: string | null, commands?: { name: string; source: string }[], entries?: PiEntry[]) {
  const spawned: FakePi[] = [];
  const instance = createPiInstance({}, env, {
    bridgePath,
    probe: async () => "1.1.0",
    spawn: () => {
      const pi = fakePi((command, self) => {
        baseScript({ ...(commands ? { commands } : {}), ...(entries ? { entries } : {}) })(command, self);
        if (command["type"] === "prompt") {
          self.emitLine({ type: "response", id: command["id"], command: "prompt", success: true });
          self.emitLine({ type: "agent_settled" });
        }
      });
      spawned.push(pi);
      return pi;
    },
    fetch: async () => ({ ok: false, json: async () => undefined }),
  });
  return { instance, spawned };
}

describe("tide-bridge missing (D2)", () => {
  it("refuses approval-required, auto-accept-edits and plan without the bridge, before spawning pi", async () => {
    const { instance, spawned } = instanceWith(null);
    await expect(instance.openSession({ ...options, mode: "approval-required" })).rejects.toThrow(/cannot enforce approvals without tide-bridge/);
    await expect(instance.openSession({ ...options, mode: "auto-accept-edits" })).rejects.toThrow(/cannot enforce approvals for commands/);
    await expect(instance.openSession({ ...options, mode: "auto", interaction: "plan" })).rejects.toThrow(/cannot enforce plan mode/);
    expect(spawned).toHaveLength(0);
  });

  it("opens Auto without the bridge and says so in one info row on the first turn only", async () => {
    const { instance } = instanceWith(null);
    const session = await instance.openSession({ ...options, mode: "auto" });
    const first = await collect(session.send({ text: "hi" }));
    const infos = first.flatMap((event) => (event.type === "activity" && event.activity.kind === "info" ? [event.activity.text] : []));
    expect(infos).toEqual([expect.stringMatching(/^Tide tools are not available in this session: tide-bridge was not found/)]);
    const second = await collect(session.send({ text: "again" }));
    expect(second.some((event) => event.type === "activity" && event.activity.kind === "info")).toBe(false);
    await session.close();
  });

  it("warns (does not refuse) when the bridge was passed but did not register /tide-config", async () => {
    const { instance } = instanceWith("/tmp/tide-bridge.js", []);
    const session = await instance.openSession({ ...options, mode: "approval-required" });
    const events = await collect(session.send({ text: "hi" }));
    const infos = events.flatMap((event) => (event.type === "activity" && event.activity.kind === "info" ? [event.activity.text] : []));
    expect(infos).toEqual([expect.stringMatching(/did not register in pi, so approvals and plan mode are not enforced/)]);
    await session.close();
  });

  it("no row when the bridge registered", async () => {
    const { instance } = instanceWith("/tmp/tide-bridge.js");
    const session = await instance.openSession(options);
    const events = await collect(session.send({ text: "hi" }));
    expect(events.some((event) => event.type === "activity" && event.activity.kind === "info")).toBe(false);
    await session.close();
  });

  it("status carries a hint while the bridge cannot be found", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-pi-home-"));
    const instance = createPiInstance({ binaryPath: "/usr/bin/env", env: { HOME: dir, OPENAI_API_KEY: "x" } }, env, {
      bridgePath: null,
      spawn: () =>
        fakePi((command, pi) => {
          baseScript()(command, pi);
          if (command["type"] === "get_available_thinking_levels") pi.emitLine({ type: "response", id: command["id"], command: "get_available_thinking_levels", success: true, data: { levels: [] } });
          if (command["type"] === "get_available_models") pi.emitLine({ type: "response", id: command["id"], command: "get_available_models", success: true, data: { models: [] } });
        }),
      fetch: async (url) => (url === OLLAMA_TAGS_URL ? { ok: true, json: async () => ({ models: [] }) } : Promise.reject(new Error("ECONNREFUSED"))),
      probe: async () => "1.1.0",
    });
    const status = await instance.status();
    expect(status.loggedIn).toBe(true);
    expect(status.hint).toMatch(/tide-bridge not found: pi threads run only in Auto mode/);
    await instance.dispose();
  });
});

describe("resume of a pi session file that is gone (D1)", () => {
  it("sessionFileGone: missing or empty path yes; a file with content or a bare id no", () => {
    const dir = mkdtempSync(join(tmpdir(), "tide-pi-resume-"));
    writeFileSync(join(dir, "empty.jsonl"), "");
    writeFileSync(join(dir, "full.jsonl"), '{"type":"session"}\n');
    expect(sessionFileGone(join(dir, "missing.jsonl"))).toBe(true);
    expect(sessionFileGone(join(dir, "empty.jsonl"))).toBe(true);
    expect(sessionFileGone(join(dir, "full.jsonl"))).toBe(false);
    expect(sessionFileGone("abc123")).toBe(false);
  });

  it("reports resumeFailed when the file is gone and pi opened it empty", async () => {
    const { instance } = instanceWith("/tmp/tide-bridge.js");
    const resume = join(mkdtempSync(join(tmpdir(), "tide-pi-resume-")), "gone.jsonl");
    const session = (await instance.openSession({ ...options, resume })) as Reporting;
    expect(session.resumeFailed).toBe(`the pi session file ${resume} is missing or empty`);
    await session.close();
  });

  it("no report when pi still holds user messages, or when nothing was resumed", async () => {
    const entries: PiEntry[] = [{ type: "message", id: "e1", parentId: null, message: { role: "user" } }];
    const { instance } = instanceWith("/tmp/tide-bridge.js", undefined, entries);
    const resumed = (await instance.openSession({ ...options, resume: "/tmp/tide-pi-nowhere/gone.jsonl" })) as Reporting;
    expect(resumed.resumeFailed).toBeUndefined();
    const fresh = (await instance.openSession(options)) as Reporting;
    expect(fresh.resumeFailed).toBeUndefined();
    await Promise.all([resumed.close(), fresh.close()]);
  });
});
