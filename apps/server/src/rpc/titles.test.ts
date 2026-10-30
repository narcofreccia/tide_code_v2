import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, ProviderInstance } from "@tide/contracts";
import { openDatabase } from "../db/sqlite.ts";
import { Engine } from "../orchestration/engine.ts";
import { EventStore } from "../orchestration/store.ts";
import { SettingsStore } from "../settings.ts";
import { cleanTitle, regenerateTitle, TITLE_SYSTEM, titlePrompt, type TitleDeps } from "./titles.ts";

async function rig(options: { oneShot?: boolean; complete?: (r: CompletionRequest) => Promise<CompletionResult>; textModel?: { provider: "claude" | "codex"; model?: string } } = {}) {
  const engine = new Engine({ store: new EventStore(await openDatabase(":memory:")) });
  const project = (await engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
  if (project?.type !== "project.created") throw new Error("expected project");
  const created = (await engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
  if (created?.type !== "thread.created") throw new Error("expected thread");
  const threadId = created.thread.id;
  await engine.dispatch({ type: "turn.request", threadId, text: "x".repeat(700) });
  const turnId = Object.values(engine.getModel().turns)[0]!.id;
  await engine.dispatch({ type: "turn.start", turnId, provider: "claude" });
  await engine.dispatch({ type: "assistant.append", turnId, messageId: "a1", delta: "Done: fixed the login redirect." });
  await engine.dispatch({ type: "turn.settle", turnId, status: "completed" });
  const requests: CompletionRequest[] = [];
  const instance = {
    kind: "claude",
    ...(options.complete !== undefined ? { complete: (r: CompletionRequest) => (requests.push(r), options.complete!(r)) } : {}),
  } as unknown as ProviderInstance;
  const settings = new SettingsStore();
  if (options.textModel) settings.set({ textModel: options.textModel });
  const registry = {
    has: (k: string) => k === "claude" || k === "codex",
    get: async () => instance,
    status: async () => ({ caps: { oneShot: options.oneShot ?? true } }),
    statusAll: async () => [
      { kind: "codex", caps: { oneShot: false } },
      { kind: "claude", caps: { oneShot: options.oneShot ?? true } },
    ],
  } as unknown as TitleDeps["registry"];
  const deps: TitleDeps = { engine, registry, settings, tideHome: mkdtempSync(join(tmpdir(), "tide-titles-")) };
  return { deps, engine, threadId, requests };
}

const answer = (text: string): Promise<CompletionResult> => Promise.resolve({ text, elapsedMs: 5, model: "haiku-x" });

describe("titles", () => {
  it("cleans the model's answer", () => {
    expect(cleanTitle('Title: "Fix the login redirect."\nextra')).toBe("Fix the login redirect");
    expect(cleanTitle(`${"a".repeat(80)}`)).toHaveLength(60);
    expect(cleanTitle("  \n ")).toBe("");
  });

  it("builds the prompt from the first user message and latest reply, clipped", async () => {
    const { engine, threadId } = await rig();
    const prompt = titlePrompt(engine.getModel(), threadId);
    expect(prompt).toContain("First request:\n" + "x".repeat(599) + "…");
    expect(prompt).toContain("Latest reply:\nDone: fixed the login redirect.");
  });

  it("asks the first one-shot harness, applies the title through the engine", async () => {
    const { deps, engine, threadId, requests } = await rig({ complete: () => answer('"Fix login redirect."') });
    const out = await regenerateTitle(deps, threadId);
    expect(out).toEqual({ title: "Fix login redirect", provider: "claude", model: "haiku-x" });
    expect(requests[0]?.system).toBe(TITLE_SYSTEM);
    expect(engine.getModel().threads[threadId]?.title).toBe("Fix login redirect");
  });

  it("prefers settings.textModel", async () => {
    const { deps, requests, threadId } = await rig({ complete: () => answer("T"), textModel: { provider: "codex", model: "mini" } });
    const out = await regenerateTitle(deps, threadId);
    expect(out.provider).toBe("codex");
    expect(requests[0]?.model).toBe("mini");
  });

  it("maps failures to stable codes", async () => {
    const a = await rig({ complete: () => answer("T") });
    await expect(regenerateTitle(a.deps, "nope")).rejects.toMatchObject({ code: "not-found" });
    const b = await rig({ oneShot: false, complete: () => answer("T") });
    await expect(regenerateTitle({ ...b.deps, registry: { ...b.deps.registry, statusAll: async () => [] } as TitleDeps["registry"] }, b.threadId)).rejects.toMatchObject({ code: "conflict" });
    const c = await rig({ complete: () => Promise.reject(new Error("harness exploded")) });
    await expect(regenerateTitle(c.deps, c.threadId)).rejects.toMatchObject({ code: "internal", message: "harness exploded" });
    const d = await rig({ complete: () => answer("") });
    await expect(regenerateTitle(d.deps, d.threadId)).rejects.toMatchObject({ code: "internal" });
  });
});
