import type { InteractionMode, ProviderKind, RuntimeMode } from "@tide/contracts";

export const PROVIDERS: ProviderKind[] = ["claude", "codex", "opencode", "pi"];

/** Display names; the wire uses the lowercase kind. */
export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  pi: "Pi",
};
export const RUNTIME_MODES: RuntimeMode[] = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];
export const INTERACTION_MODES: InteractionMode[] = ["default", "plan"];
