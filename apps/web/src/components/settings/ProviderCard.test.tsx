import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ProviderStatusDto } from "@tide/contracts";
import { ProviderCard } from "./ProviderCard.tsx";
import { PROVIDER_FIXTURE } from "./fixtures.ts";

afterEach(() => cleanup());

const caps = PROVIDER_FIXTURE[0]!.caps;

describe("ProviderCard install steps", () => {
  it("shows the install command with Copy and the docs link when the harness is missing", () => {
    const status = {
      id: "codex",
      kind: "codex",
      label: "Codex",
      installed: false,
      loggedIn: false,
      hint: "Install Codex: run `npm i -g @openai/codex` in a terminal",
      install: { command: "npm i -g @openai/codex", url: "https://github.com/openai/codex" },
      models: [],
      caps,
    } as ProviderStatusDto;
    render(<ProviderCard status={status} />);
    const install = screen.getByLabelText("Install Codex");
    expect(within(install).getByText("npm i -g @openai/codex")).toBeDefined();
    expect(within(install).getByRole("button", { name: "Copy" })).toBeDefined();
    expect(within(install).getByRole("link", { name: "Codex docs" }).getAttribute("href")).toBe("https://github.com/openai/codex");
    // the driver hint that only repeats the command is not shown twice
    expect(screen.queryByText(/Install Codex: run/)).toBeNull();
  });

  it("shows no install step for an installed harness", () => {
    render(<ProviderCard status={PROVIDER_FIXTURE[0]!} />);
    expect(screen.queryByLabelText("Install Claude Code")).toBeNull();
  });
});
