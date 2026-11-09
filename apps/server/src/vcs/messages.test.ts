import { afterEach, describe, expect, it } from "vitest";
import type { CompletionRequest, ProviderInstance } from "@tide/contracts";
import type { OneShotDeps } from "../rpc/oneShot.ts";
import { SettingsStore } from "../settings.ts";
import { formatCommitMessage, generateCommitMessage, parseMessage, PATCH_EXCERPT_BYTES } from "./messages.ts";
import { createTempRepo, type TempRepo } from "./testing/tempRepo.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function deps(complete: ((r: CompletionRequest) => Promise<{ text: string; elapsedMs: number }>) | undefined, oneShot = true): { deps: OneShotDeps; requests: CompletionRequest[] } {
  const requests: CompletionRequest[] = [];
  const instance = {
    kind: "claude",
    ...(complete !== undefined ? { complete: (r: CompletionRequest) => (requests.push(r), complete(r)) } : {}),
  } as unknown as ProviderInstance;
  const registry = {
    has: () => true,
    get: async () => instance,
    statusAll: async () => [{ kind: "claude", caps: { oneShot } }],
  } as unknown as OneShotDeps["registry"];
  return { deps: { registry, settings: new SettingsStore() }, requests };
}

async function repoWithStagedChange(): Promise<TempRepo> {
  const repo = await createTempRepo("tide-messages-");
  cleanups.push(() => repo.cleanup());
  await repo.write("src/app.ts", `${"x".repeat(PATCH_EXCERPT_BYTES * 2)}\n`);
  await repo.git.run(["add", "-A"]);
  return repo;
}

describe("generated commit messages", () => {
  it("parses subject and body, stripping labels, quotes and fences", () => {
    expect(parseMessage('```\nSubject: "Fix the login redirect."\n\nBody: Because it looped.\n```')).toEqual({
      subject: "Fix the login redirect",
      body: "Because it looped.",
    });
    expect(parseMessage("  \n")).toBeUndefined();
    expect(parseMessage("a".repeat(100))?.subject).toHaveLength(72);
    expect(formatCommitMessage({ subject: "S", body: "B" })).toBe("S\n\nB");
  });

  it("prompts with the diff stat and a clipped patch", async () => {
    const repo = await repoWithStagedChange();
    const { deps: d, requests } = deps(async () => ({ text: "Add app\n\nWhy.", elapsedMs: 1 }));
    const message = await generateCommitMessage(d, { git: repo.git, threadTitle: "App", kind: "commit", range: ["--cached"] });
    expect(message).toEqual({ subject: "Add app", body: "Why." });
    expect(requests[0]?.prompt).toContain("src/app.ts | 1 +");
    expect(requests[0]?.prompt).toContain("… (patch truncated)");
    expect(requests[0]?.prompt.length).toBeLessThan(PATCH_EXCERPT_BYTES + 1_000);
    expect(requests[0]?.timeoutMs).toBe(5_000);
  });

  it("any failure is undefined: no harness, an error, an empty answer, nothing to describe", async () => {
    const repo = await repoWithStagedChange();
    const input = { git: repo.git, threadTitle: "App", kind: "pr" as const, range: ["--cached"] };
    expect(await generateCommitMessage(deps(undefined).deps, input)).toBeUndefined();
    expect(await generateCommitMessage(deps(async () => ({ text: "x", elapsedMs: 1 }), false).deps, input)).toBeUndefined();
    expect(await generateCommitMessage(deps(() => Promise.reject(new Error("boom"))).deps, input)).toBeUndefined();
    expect(await generateCommitMessage(deps(async () => ({ text: " \n", elapsedMs: 1 })).deps, input)).toBeUndefined();
    const { deps: d, requests } = deps(async () => ({ text: "x", elapsedMs: 1 }));
    expect(await generateCommitMessage(d, { ...input, range: ["HEAD", "HEAD"] })).toBeUndefined();
    expect(requests).toHaveLength(0);
  });
});
