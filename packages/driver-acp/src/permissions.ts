import type { ApprovalDecision, InteractionMode, RuntimeMode } from "@tide/contracts";
import type { AcpConfigOption, AcpModes, AcpPermissionOption, AcpSelectOption, AcpToolKind } from "./types.ts";

/**
 * Tide's RuntimeMode applied to ACP. ACP has no portable permission knob: each agent names its
 * own modes. So the driver (1) answers `session/request_permission` itself according to the
 * mode, and (2) best-effort selects an agent mode whose id/name matches the Tide mode, without
 * hardcoding any agent's ids.
 */

/** Tool kinds `auto-accept-edits` answers without asking. `execute` and `other` still ask. */
const EDIT_LIKE: ReadonlySet<string> = new Set<AcpToolKind>(["edit", "move", "delete", "read", "search", "think", "fetch"]);

export type PermissionPlan = { kind: "forward" } | { kind: "auto"; optionId: string; audit: boolean };

function pick(options: AcpPermissionOption[], ...kinds: string[]): AcpPermissionOption | undefined {
  for (const kind of kinds) {
    const found = options.find((option) => option.kind === kind);
    if (found) return found;
  }
  return undefined;
}

/** What to do with one permission request under `mode`. Falls back to forwarding when no allow option exists. */
export function planPermission(mode: RuntimeMode, toolKind: string | null | undefined, options: AcpPermissionOption[]): PermissionPlan {
  if (mode === "approval-required") return { kind: "forward" };
  if (mode === "auto-accept-edits") {
    if (!toolKind || !EDIT_LIKE.has(toolKind)) return { kind: "forward" };
    const option = pick(options, "allow_once", "allow_always");
    return option ? { kind: "auto", optionId: option.optionId, audit: false } : { kind: "forward" };
  }
  const option = mode === "full-access" ? pick(options, "allow_always", "allow_once") : pick(options, "allow_once", "allow_always");
  return option ? { kind: "auto", optionId: option.optionId, audit: true } : { kind: "forward" };
}

/** Tide's decision → the agent's option id; undefined = answer `cancelled`. */
export function decisionOption(decision: ApprovalDecision, options: AcpPermissionOption[]): string | undefined {
  switch (decision) {
    case "accept":
      return pick(options, "allow_once", "allow_always")?.optionId;
    case "acceptForSession":
    case "acceptAlways":
      return pick(options, "allow_always", "allow_once")?.optionId;
    case "decline":
      return pick(options, "reject_once", "reject_always")?.optionId;
    case "cancel":
      return undefined;
  }
}

// ---- agent modes / config options ----

const PLAN = /plan/i;
const FULL = /yolo|bypass|full|auto/i;
const EDITS = /accept.?edits|auto.?edit/i;

export function modePattern(mode: RuntimeMode): RegExp | undefined {
  if (mode === "full-access") return FULL;
  if (mode === "auto-accept-edits") return EDITS;
  return undefined;
}

export function flattenOptions(option: AcpConfigOption): AcpSelectOption[] {
  return (option.options ?? []).flatMap((entry) => ("group" in entry && Array.isArray(entry.options) ? entry.options : [entry as AcpSelectOption]));
}

/** The mode selector the agent exposes: a `category: "mode"` config option, else legacy `modes`. */
export interface ModeSelector {
  kind: "config" | "modes";
  /** config option id (kind config) */
  configId?: string;
  choices: { id: string; name: string }[];
  current: string;
}

export function modeSelector(modes: AcpModes | null | undefined, configOptions: AcpConfigOption[] | null | undefined): ModeSelector | undefined {
  const option = (configOptions ?? []).find((entry) => entry.category === "mode" && entry.type === "select");
  if (option) {
    return {
      kind: "config",
      configId: option.id,
      choices: flattenOptions(option).map((choice) => ({ id: choice.value, name: choice.name })),
      current: String(option.currentValue ?? ""),
    };
  }
  if (modes && Array.isArray(modes.availableModes) && modes.availableModes.length > 0) {
    return { kind: "modes", choices: modes.availableModes.map((mode) => ({ id: mode.id, name: mode.name })), current: modes.currentModeId };
  }
  return undefined;
}

function match(selector: ModeSelector, pattern: RegExp): string | undefined {
  return selector.choices.find((choice) => pattern.test(choice.id) || pattern.test(choice.name))?.id;
}

export function planModeId(selector: ModeSelector | undefined): string | undefined {
  return selector ? match(selector, PLAN) : undefined;
}

/**
 * Which agent mode a session should be in. Plan interaction wins (it is the same selector);
 * otherwise a mode matching the runtime mode; otherwise the agent's initial mode (`base`).
 */
export function targetModeId(selector: ModeSelector | undefined, base: string | undefined, mode: RuntimeMode, interaction: InteractionMode): string | undefined {
  if (!selector) return undefined;
  if (interaction === "plan") {
    const plan = planModeId(selector);
    if (plan) return plan;
  }
  const pattern = modePattern(mode);
  const matched = pattern ? selector.choices.find((choice) => !PLAN.test(choice.id) && (pattern.test(choice.id) || pattern.test(choice.name)))?.id : undefined;
  return matched ?? base;
}
