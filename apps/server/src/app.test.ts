import { describe, expect, it } from "vitest";
import { createApp } from "./app.ts";
import type { ServerConfig } from "./config.ts";
import { createFakeDriver, emit } from "./provider/testing/fakeDriver.ts";

const config: ServerConfig = {
  tideHome: "/tmp/tide-app-test",
  dataDir: ":memory:",
  dbPath: ":memory:",
  environmentId: "env-app",
  token: "t",
  host: "127.0.0.1",
  port: 0,
  dev: true,
  printToken: false,
  corsOrigins: [],
  version: "0.0.0-test",
  providers: {},
};

describe("createApp", () => {
  it("wires engine, registry, sessions and reactor so a turn runs end to end", async () => {
    const { driver, control } = createFakeDriver("claude");
    const app = await createApp({
      config,
      listen: false,
      log: () => undefined,
      registerDrivers: (registry) => registry.register(driver),
    });
    try {
      expect(app.registry.list()).toEqual(["claude"]);
      expect(app.server).toBeUndefined();

      const project = (await app.engine.dispatch({ type: "project.create", title: "T", rootPath: "/repo" })).events[0]?.event;
      if (project?.type !== "project.created") throw new Error("expected project.created");
      const thread = (await app.engine.dispatch({ type: "thread.create", projectId: project.project.id, provider: "claude" })).events[0]?.event;
      if (thread?.type !== "thread.created") throw new Error("expected thread.created");

      control.script(emit({ type: "assistant.delta", messageKey: "m", delta: "pong" }), emit({ type: "settled", status: "completed" }));
      await app.engine.dispatch({ type: "turn.request", threadId: thread.thread.id, text: "ping" });
      await app.reactor.drain();

      const model = app.engine.getModel();
      const texts = (model.threadMessages[thread.thread.id] ?? []).map((id) => model.messages[id]?.text);
      expect(texts).toEqual(["ping", "pong"]);
      expect(model.threads[thread.thread.id]?.status).toBe("idle");
    } finally {
      await app.close();
    }
  });
});
