import type { ProviderKind, ProviderStatusDto } from "@tide/contracts";

const NO_CAPS: ProviderStatusDto["caps"] = {
  planMode: false,
  subagents: false,
  mcp: false,
  images: false,
  resume: false,
  contextUsage: false,
  openInTerminal: false,
};

const LABELS: Record<ProviderKind, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode", pi: "Pi", acp: "ACP agent" };

function missing(kind: ProviderKind): ProviderStatusDto {
  return {
    id: kind,
    kind,
    label: LABELS[kind],
    installed: false,
    loggedIn: false,
    hint: "driver not available in this build",
    models: [],
    caps: { ...NO_CAPS },
  };
}

/** What `providers.list` answers today: Claude wired up, the other three pending. */
export const PROVIDER_FIXTURE: ProviderStatusDto[] = [
  {
    id: "claude",
    kind: "claude",
    label: "Claude Code",
    installed: true,
    loggedIn: true,
    version: "2.1.251",
    models: [
      { id: "opus-4-6", label: "Opus 4.6", family: "opus" },
      { id: "sonnet-4-6", label: "Sonnet 4.6", family: "sonnet", default: true },
    ],
    caps: {
      planMode: true,
      subagents: true,
      mcp: true,
      images: true,
      resume: true,
      contextUsage: true,
      openInTerminal: true,
    },
  },
  missing("codex"),
  missing("opencode"),
  missing("pi"),
];

export const LOGGED_OUT: ProviderStatusDto = {
  id: "claude",
  kind: "claude",
  label: "Claude Code",
  installed: true,
  loggedIn: false,
  version: "2.1.251",
  hint: "Run `claude auth login` in a terminal",
  models: [],
  caps: { ...NO_CAPS },
};

/** R8: a ready second Codex account and an ACP agent, next to the bundled roster. */
export const CODEX_WORK: ProviderStatusDto = {
  id: "codex:work",
  kind: "codex",
  label: "Codex · work",
  installed: true,
  loggedIn: true,
  version: "0.50.0",
  models: [
    {
      id: "gpt-5-codex",
      label: "GPT-5 Codex",
      default: true,
      efforts: [
        { id: "low", label: "Low" },
        { id: "medium", label: "Medium", default: true },
        { id: "high", label: "High" },
      ],
    },
    { id: "gpt-5-mini", label: "GPT-5 mini" },
  ],
  caps: { ...NO_CAPS, resume: true, effort: true },
};

export const GEMINI: ProviderStatusDto = {
  id: "acp:gemini",
  kind: "acp",
  label: "Gemini CLI",
  installed: true,
  loggedIn: true,
  models: [{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", default: true }],
  caps: { ...NO_CAPS, commands: true },
};
