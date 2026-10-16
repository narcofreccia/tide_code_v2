import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { DriverEnv } from "@tide/contracts";
import { CompletionService } from "./complete.ts";
import { fakeSpawn } from "./fake-app-server.ts";
import { CODEX_CAPS } from "./status.ts";

function service(reply: string | undefined) {
  const env: DriverEnv = { dataDir: tmpdir(), log: () => undefined };
  const fake = fakeSpawn((server) => {
    server.autoReply = reply;
  });
  const svc = new CompletionService({ spawnImpl: fake.spawn }, env, async () => "/usr/bin/codex");
  return { svc, ...fake };
}
const base = { system: "classify", prompt: "is this ok?", timeoutMs: 2000, cwd: "/tmp/scratch" };

describe("CompletionService", () => {
  it("starts an ephemeral read-only never-approve thread and returns text + label", async () => {
    const { svc, last } = service("Safe");
    const result = await svc.complete({ ...base, labels: ["safe", "unsafe"], model: "gpt-x" });
    expect(result.text).toBe("Safe");
    expect(result.label).toBe("safe");
    expect(result.model).toBe("gpt-x");
    const start = last().calls("thread/start")[0]!;
    expect(start).toMatchObject({ ephemeral: true, sandbox: "read-only", approvalPolicy: "never", baseInstructions: "classify", cwd: "/tmp/scratch", model: "gpt-x" });
    const turn = last().calls("turn/start")[0]!;
    expect(turn).toMatchObject({ effort: "low", outputSchema: { type: "string", enum: ["safe", "unsafe"] } });
    expect(last().calls("thread/archive")).toHaveLength(1);
    svc.dispose();
  });

  it("omits label without labels and reuses one server across calls", async () => {
    const { svc, servers } = service("hello");
    const a = await svc.complete(base);
    await svc.complete(base);
    expect(a.label).toBeUndefined();
    expect(servers).toHaveLength(1);
    expect(servers[0]!.calls("turn/start")).toHaveLength(2);
    svc.dispose();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(servers[0]!.killed).toBe(1);
  });

  it("rejects with a timeout error and interrupts the turn", async () => {
    const { svc, last } = service(undefined);
    await expect(svc.complete({ ...base, timeoutMs: 20 })).rejects.toThrow(/^timeout/);
    expect(last().calls("turn/interrupt")).toHaveLength(1);
    svc.dispose();
  });

  it("rejects on abort", async () => {
    const { svc } = service(undefined);
    const controller = new AbortController();
    const pending = svc.complete({ ...base, signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await expect(pending).rejects.toThrow(/^timeout/);
    svc.dispose();
  });

  it("advertises oneShot", () => {
    expect(CODEX_CAPS.oneShot).toBe(true);
  });
});
