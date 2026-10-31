import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { CompletionRequest, CompletionResult, ProviderInstance } from "@tide/contracts";
import { completeJson, extractJsonObject } from "./json.ts";

const schema = Type.Object({ name: Type.String(), port: Type.Number() });

function fake(answers: string[]) {
  const requests: CompletionRequest[] = [];
  const instance = {
    kind: "claude",
    complete: async (r: CompletionRequest): Promise<CompletionResult> => {
      requests.push(r);
      return { text: answers.shift() ?? "", elapsedMs: 1 };
    },
  } as unknown as ProviderInstance;
  return { instance, requests };
}

const opts = { schema, system: "sys", prompt: "describe", cwd: "/tmp/x", maxOutputTokens: 100, timeoutMs: 1000 };

describe("extractJsonObject", () => {
  it("finds the first balanced object, ignoring braces in strings", () => {
    expect(extractJsonObject('Sure! {"a": "}{", "b": {"c": 1}} trailing {"d":2}')).toBe('{"a": "}{", "b": {"c": 1}}');
    expect(extractJsonObject("none")).toBeUndefined();
    expect(extractJsonObject('{"open": ')).toBeUndefined();
  });
});

describe("completeJson", () => {
  it("parses a fenced answer", async () => {
    const { instance, requests } = fake(['Here:\n```json\n{"name":"api","port":8000}\n```']);
    expect(await completeJson(instance, opts)).toEqual({ name: "api", port: 8000 });
    expect(requests[0]).toMatchObject({ system: "sys", prompt: "describe", cwd: "/tmp/x", maxOutputTokens: 100, timeoutMs: 1000 });
  });

  it("retries once with the validation errors", async () => {
    const { instance, requests } = fake(['{"name":"api","port":"8000"}', '{"name":"api","port":8000}']);
    expect(await completeJson(instance, opts)).toEqual({ name: "api", port: 8000 });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.prompt).toMatch(/^describe\n\nYour previous answer was rejected because the JSON does not match the schema:\n\/port/);
  });

  it("fails with conflict after the retry", async () => {
    const { instance, requests } = fake(["no json here", "{broken"]);
    await expect(completeJson(instance, opts)).rejects.toMatchObject({ code: "conflict" });
    expect(requests).toHaveLength(2);
  });

  it("conflict when the harness cannot do one-shot prompts", async () => {
    await expect(completeJson({ kind: "pi" } as ProviderInstance, opts)).rejects.toMatchObject({ code: "conflict" });
  });
});
