import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import {
  LMSTUDIO_MODELS_URL,
  OLLAMA_TAGS_URL,
  createPiInstance,
  detectLmStudio,
  detectLocalModels,
  detectLogin,
  detectOllama,
  ensureLocalProvider,
  INSTALL_HINT,
  LOGIN_COMMAND,
  LOGIN_HINT,
  mergeModels,
  parseLocalModelId,
  workspaceBinary,
  detectBinary,
  TESTED_PI_VERSION,
} from "../src/index.ts";
import type { FetchLike } from "../src/types.ts";
import { baseScript, fakePi } from "./fake-pi.ts";

const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };

/** Fake HTTP: a URL → body map; anything else is a connection refusal. */
function fakeFetch(bodies: Record<string, unknown>): FetchLike {
  return async (url) => {
    const body = bodies[url];
    if (body === undefined) throw new Error("ECONNREFUSED");
    return { ok: true, json: async () => body };
  };
}

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), "tide-pi-home-"));
  mkdirSync(join(dir, ".pi", "agent"), { recursive: true });
  return dir;
}

describe("local model detection", () => {
  const bodies = {
    [OLLAMA_TAGS_URL]: { models: [{ name: "qwen2.5-coder:7b" }, { name: "llama3.1:8b" }] },
    [LMSTUDIO_MODELS_URL]: { data: [{ id: "openai/gpt-oss-20b" }] },
  };

  it("reads Ollama tags and LM Studio's OpenAI model list", async () => {
    expect(await detectOllama(fakeFetch(bodies))).toEqual(["qwen2.5-coder:7b", "llama3.1:8b"]);
    expect(await detectLmStudio(fakeFetch(bodies))).toEqual(["openai/gpt-oss-20b"]);
  });

  it("exposes them as models with an ollama / lmstudio family", async () => {
    const models = await detectLocalModels(fakeFetch(bodies));
    expect(models).toEqual([
      { id: "ollama/qwen2.5-coder:7b", label: "qwen2.5-coder:7b (Ollama)", family: "ollama" },
      { id: "ollama/llama3.1:8b", label: "llama3.1:8b (Ollama)", family: "ollama" },
      { id: "lmstudio/openai/gpt-oss-20b", label: "openai/gpt-oss-20b (LM Studio)", family: "lmstudio" },
    ]);
  });

  it("returns nothing when no local server answers", async () => {
    expect(await detectLocalModels(fakeFetch({}))).toEqual([]);
  });
});

describe("ensureLocalProvider", () => {
  it("only writes models.json when a local model is actually picked", () => {
    const path = join(home(), ".pi", "agent", "models.json");
    expect(parseLocalModelId("anthropic/claude-sonnet-4")).toBeUndefined();
    expect(ensureLocalProvider("anthropic/claude-sonnet-4", path)).toBeUndefined();

    expect(ensureLocalProvider("ollama/qwen2.5-coder:7b", path)).toBe(path);
    const written = JSON.parse(readFileSync(path, "utf8")) as { providers: Record<string, { baseUrl: string; api: string; apiKey: string; models: { id: string }[] }> };
    expect(written.providers["ollama"]).toMatchObject({ baseUrl: "http://localhost:11434/v1", api: "openai-completions", apiKey: "ollama", models: [{ id: "qwen2.5-coder:7b" }] });
  });

  it("appends to an existing provider and preserves unrelated ones", () => {
    const path = join(home(), ".pi", "agent", "models.json");
    writeFileSync(path, JSON.stringify({ providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "x" }] } } }));
    ensureLocalProvider("ollama/a", path);
    ensureLocalProvider("ollama/b", path);
    const written = JSON.parse(readFileSync(path, "utf8")) as { providers: Record<string, { models: { id: string }[] }> };
    expect(written.providers["ollama"]?.models).toEqual([{ id: "a" }, { id: "b" }]);
    expect(written.providers["openrouter"]?.models).toEqual([{ id: "x" }]);
  });
});

describe("detectLogin", () => {
  it("is false for a fresh install with an empty auth.json", () => {
    const dir = home();
    writeFileSync(join(dir, ".pi", "agent", "auth.json"), "[]");
    expect(detectLogin({}, dir)).toBe(false);
  });

  it("accepts an auth.json entry, an API key in the env, or a custom provider", () => {
    const withAuth = home();
    writeFileSync(join(withAuth, ".pi", "agent", "auth.json"), JSON.stringify({ anthropic: { type: "oauth" } }));
    expect(detectLogin({}, withAuth)).toBe(true);

    const bare = home();
    expect(detectLogin({ OPENAI_API_KEY: "sk-test" }, bare)).toBe(true);
    expect(detectLogin({ OPENAI_API_KEY: "" }, bare)).toBe(false);

    const withModels = home();
    writeFileSync(join(withModels, ".pi", "agent", "models.json"), JSON.stringify({ providers: { ollama: { models: [{ id: "a" }] } } }));
    expect(detectLogin({}, withModels)).toBe(true);
  });
});

describe("status()", () => {
  it("reports pi's own catalogue merged with live local models, and caches for 60s", async () => {
    const instance = createPiInstance(
      { binaryPath: "/usr/bin/env" },
      env,
      {
        spawn: () =>
          fakePi((command, pi) => {
            baseScript()(command, pi);
            if (command["type"] === "get_available_models") {
              pi.emitLine({ type: "response", id: command["id"], command: "get_available_models", success: true, data: { models: [{ id: "gpt-5.5", name: "GPT-5.5", provider: "openai" }] } });
            }
          }),
        fetch: fakeFetch({ [OLLAMA_TAGS_URL]: { models: [{ name: "llama3.1:8b" }] } }),
        probe: async () => "1.1.0",
      },
    );
    const status = await instance.status();
    expect(status.kind).toBe("pi");
    expect(status.installed).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.models.map((model) => model.id)).toEqual(["openai/gpt-5.5", "ollama/llama3.1:8b"]);
    expect(status.version).toBe("1.1.0");
    expect(status.caps).toMatchObject({ planMode: true, subagents: false, mcp: true, resume: true, contextUsage: true });
    expect(await instance.status()).toBe(status);
    expect(instance.terminalCommand("/tmp/my sessions/a.jsonl", "/tmp/my repo")).toBe("cd '/tmp/my repo' && pi --session '/tmp/my sessions/a.jsonl'");
    await instance.dispose();
  });

  it("puts a runnable command first in every hint", () => {
    expect(/`([^`]+)`/.exec(LOGIN_HINT)?.[1]).toBe("pi");
    expect(/`([^`]+)`/.exec(INSTALL_HINT)?.[1]).toBe("npm i -g @earendil-works/pi-coding-agent");
  });

  it("offers the runnable login command as its own field, not only buried in the hint", () => {
    // pi has no non-interactive login; the user runs `pi` and types /login, which the hint says
    expect(LOGIN_COMMAND).toBe("pi");
    expect(LOGIN_HINT).toContain("/login");
  });

  it("sets loginCommand only when pi is installed but has no credentials", async () => {
    const instance = createPiInstance({ binaryPath: "/usr/bin/env" }, env, {
      spawn: () => fakePi(),
      probe: async () => "1.1.0",
      // no local model servers answer, so login rests on credentials alone
      fetch: async () => ({ ok: false, json: async () => undefined }),
    });
    const status = await instance.status();
    expect(status.loginCommand).toBe(status.installed && !status.loggedIn ? LOGIN_COMMAND : undefined);
    await instance.dispose();
  });
});

describe("binary + model helpers", () => {
  it("prefers config, then the workspace's own pi, then PATH — skipping any that fail --version", async () => {
    const workspace = workspaceBinary();
    expect(workspace).toMatch(/node_modules\/\.bin\/pi$/);
    const ok = async () => "1.1.0";
    // an explicit, working binaryPath wins
    expect(await detectBinary({ binaryPath: "/usr/bin/env" }, ok)).toEqual({ path: "/usr/bin/env", version: "1.1.0" });
    // a missing one falls through to the workspace copy
    expect((await detectBinary({ binaryPath: "/nowhere/pi" }, ok))?.path).toBe(workspace);
    // one that crashes on --version is skipped, with a log line saying so
    const logs: string[] = [];
    const crashesFirst = async (binary: string) => (binary === "/usr/bin/env" ? undefined : "1.1.0");
    expect((await detectBinary({ binaryPath: "/usr/bin/env" }, crashesFirst, (line) => logs.push(line)))?.path).toBe(workspace);
    expect(logs.some((line) => line.includes("/usr/bin/env --version failed"))).toBe(true);
    // nothing usable at all → not installed
    expect(await detectBinary({}, async () => undefined)).toBeUndefined();
  });

  it("the workspace pi really answers --version with the pinned release", async () => {
    const detected = await detectBinary({});
    expect(detected?.path).toBe(workspaceBinary());
    expect(detected?.version).toBe(TESTED_PI_VERSION);
  }, 30_000);

  it("mergeModels keeps pi's own entries and drops duplicate local ids", () => {
    const merged = mergeModels([{ id: "ollama/a", label: "from pi" }], [{ id: "ollama/a", label: "live" }, { id: "ollama/b", label: "live" }]);
    expect(merged.map((model) => model.label)).toEqual(["from pi", "live"]);
  });
});
