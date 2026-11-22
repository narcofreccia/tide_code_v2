import type { ModelInfo } from "@tide/contracts";
import type { AcpConfigOption, AcpLegacyModels, AcpSelectOption } from "./types.ts";

/**
 * Models and reasoning effort come from the agent, never a table (CLAUDE.md §1a):
 *  - `configOptions` with `category: "model"` / `"thought_level"` (ACP v1), or
 *  - the legacy `models {currentModelId, availableModels}` block + `session/set_model`
 *    (pre-configOptions; OpenCode 1.1.x still answers only this).
 */

export interface ModelSelector {
  kind: "config" | "legacy";
  configId?: string;
  models: ModelInfo[];
  current?: string;
}

export interface EffortSelector {
  configId: string;
  efforts: NonNullable<ModelInfo["efforts"]>;
  current?: string;
}

function selectOf(configOptions: AcpConfigOption[] | null | undefined, category: string): AcpConfigOption | undefined {
  return (configOptions ?? []).find((option) => option.category === category && option.type === "select");
}

function flattenWithGroup(option: AcpConfigOption): { choice: AcpSelectOption; group?: string }[] {
  return (option.options ?? []).flatMap((entry) =>
    "group" in entry && Array.isArray(entry.options)
      ? entry.options.map((choice) => ({ choice, group: entry.name || entry.group }))
      : [{ choice: entry as AcpSelectOption }],
  );
}

/** Short family label for grouping models in pickers (e.g. `gemini-2.5-pro` → `gemini-2.5`, `claude-sonnet-5-5` → `sonnet`). */
export function inferModelFamily(id: string, group?: string): string | undefined {
  if (group !== undefined && group.trim() !== "") return group.trim();
  const bare = id.includes("/") ? (id.split("/").pop() ?? id) : id;
  const claude = /\b(opus|sonnet|haiku|fable)\b/i.exec(bare);
  if (claude?.[1]) return claude[1].toLowerCase();
  const prefix = /^([a-z]+-[\d.]+)/i.exec(bare);
  if (prefix?.[1]) return prefix[1].toLowerCase();
  return undefined;
}

export function effortSelector(configOptions: AcpConfigOption[] | null | undefined): EffortSelector | undefined {
  const option = selectOf(configOptions, "thought_level");
  if (!option) return undefined;
  const current = option.currentValue === undefined || option.currentValue === null ? undefined : String(option.currentValue);
  const efforts = flattenWithGroup(option).map(({ choice }) => ({ id: choice.value, label: choice.name, ...(choice.value === current ? { default: true } : {}) }));
  return { configId: option.id, efforts, ...(current !== undefined ? { current } : {}) };
}

export function modelSelector(configOptions: AcpConfigOption[] | null | undefined, legacy: AcpLegacyModels | null | undefined, defaultModel?: string): ModelSelector | undefined {
  const efforts = effortSelector(configOptions)?.efforts;
  const withEfforts = (model: ModelInfo): ModelInfo => (efforts && efforts.length > 0 ? { ...model, efforts } : model);
  const option = selectOf(configOptions, "model");
  if (option) {
    const current = option.currentValue === undefined || option.currentValue === null ? undefined : String(option.currentValue);
    const preferred = defaultModel ?? current;
    const models = flattenWithGroup(option).map(({ choice, group }) => {
      const family = inferModelFamily(choice.value, group);
      return withEfforts({ id: choice.value, label: choice.name, ...(family ? { family } : {}), default: choice.value === preferred });
    });
    return { kind: "config", configId: option.id, models, ...(current !== undefined ? { current } : {}) };
  }
  if (legacy && Array.isArray(legacy.availableModels) && legacy.availableModels.length > 0) {
    const preferred = defaultModel ?? legacy.currentModelId;
    const models = legacy.availableModels.map((model) => {
      const family = inferModelFamily(model.modelId);
      return withEfforts({ id: model.modelId, label: model.name, ...(family ? { family } : {}), default: model.modelId === preferred });
    });
    return { kind: "legacy", models, current: legacy.currentModelId };
  }
  return undefined;
}
