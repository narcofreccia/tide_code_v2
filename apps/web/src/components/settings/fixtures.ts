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

function missing(kind: ProviderKind): ProviderStatusDto {
  return {
    kind,
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
    kind: "claude",
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
  kind: "claude",
  installed: true,
  loggedIn: false,
  version: "2.1.251",
  hint: "Run `claude auth login` in a terminal",
  models: [],
  caps: { ...NO_CAPS },
};
