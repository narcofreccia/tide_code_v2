import type { InteractionMode, ProviderKind, RuntimeMode } from "@tide/contracts";

export const PROVIDERS: ProviderKind[] = ["claude", "codex", "opencode", "pi"];
export const RUNTIME_MODES: RuntimeMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
export const INTERACTION_MODES: InteractionMode[] = ["default", "plan"];
