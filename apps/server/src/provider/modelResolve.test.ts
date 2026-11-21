import { describe, expect, it } from "vitest";
import { modelNote, resolveModel, type ListedModel } from "./modelResolve.ts";

const claude: ListedModel[] = [
  { id: "default", label: "Default" },
  { id: "opus", label: "Opus 5.5" },
  { id: "fable", label: "Fable 5" },
  { id: "sonnet", label: "Sonnet 5.5" },
  { id: "haiku", label: "Haiku 4.5" },
];
const codex: ListedModel[] = [
  { id: "gpt-6.2-sol", label: "GPT-6.2-Sol" },
  { id: "gpt-6.1", label: "GPT-6.1" },
];

describe("resolveModel", () => {
  it.each([
    ["an exact id is kept", "opus", claude, { kind: "listed", model: "opus" }],
    ["a display name resolves to the id whose label it spells", "opus-5.5", claude, { kind: "resolved", asked: "opus-5.5", model: "opus", label: "Opus 5.5" }],
    ["case and punctuation are ignored against the id", "GPT-6.2-Sol", codex, { kind: "resolved", asked: "GPT-6.2-Sol", model: "gpt-6.2-sol", label: "GPT-6.2-Sol" }],
    ["id and label of the same model both matching resolve once", "gpt 6.1", codex, { kind: "resolved", asked: "gpt 6.1", model: "gpt-6.1", label: "GPT-6.1" }],
    ["no prefix matching", "gpt-6.2", codex, { kind: "unlisted", model: "gpt-6.2" }],
    ["a Claude full id missing from the list passes through", "claude-opus-5-5", claude, { kind: "unlisted", model: "claude-opus-5-5" }],
    ["an empty list makes no claim", "anything", [], { kind: "unknown", model: "anything" }],
    ["punctuation alone matches nothing", "--", claude, { kind: "unlisted", model: "--" }],
  ] as const)("%s", (_name, asked, models, expected) => {
    expect(resolveModel(asked, models)).toEqual(expected);
  });

  it("leaves the id unchanged when two models normalise the same", () => {
    const twins: ListedModel[] = [
      { id: "glm-5", label: "GLM 5 (free)" },
      { id: "glm.5", label: "GLM 5 paid" },
    ];
    expect(resolveModel("GLM 5", twins)).toEqual({ kind: "unlisted", model: "GLM 5" });
  });
});

describe("modelNote", () => {
  it("says which listed id replaced a display name", () => {
    expect(modelNote(resolveModel("opus-5.5", claude), "claude", claude)).toBe("model `opus-5.5` is not an id claude lists; using `opus` (Opus 5.5)");
  });

  it("lists the harness's ids for an unlisted model, capped at 16", () => {
    expect(modelNote(resolveModel("claude-opus-5-5", claude), "claude", claude)).toBe(
      "model `claude-opus-5-5` is not in claude's list (default, opus, fable, sonnet, haiku); passed as is. If the delegate fails on its model, use a listed id",
    );
    const many = Array.from({ length: 20 }, (_, i) => ({ id: `m${i}`, label: `M ${i}` }));
    const note = modelNote(resolveModel("x", many), "codex", many) ?? "";
    expect(note).toContain("m15, …)");
    expect(note).not.toContain("m16");
  });

  it("is silent for a listed id and for an empty list", () => {
    expect(modelNote(resolveModel("opus", claude), "claude", claude)).toBeUndefined();
    expect(modelNote(resolveModel("opus", []), "claude", [])).toBeUndefined();
  });
});
