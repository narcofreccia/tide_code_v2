import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("../../state/environments.ts", async () => (await import("../fleet/testEnvironments.ts")).fakeEnvironmentsModule());

import type { UserSettings } from "@tide/contracts";
import * as envs from "../../state/environments.ts";
import { twoMachines } from "../fleet/testEnvironments.ts";
import { attachFakeStore, chooseOption, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { defaultUserSettings, resetServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { ProjectsDirGroup, validateProjectsDir } from "./ProjectsDirRow.tsx";

const withDir = (projectsDir?: string): UserSettings => ({ ...defaultUserSettings(), environment: { name: "x", ...(projectsDir === undefined ? {} : { projectsDir }) } });

beforeEach(() => {
  envs.useEnvironments.setState(twoMachines());
  attachFakeStore(modelWith({}));
  useServerSettings.setState({ settings: withDir("/home/me/code"), loaded: true, byEnv: { "env-b": { settings: withDir(), loaded: true } } });
});

afterEach(() => {
  cleanup();
  resetUi();
  resetServerSettings();
  vi.clearAllMocks();
});

describe("Settings › Environments › Projects folder", () => {
  it("shows this machine's folder and saves a new one; clearing sends null", async () => {
    const caller = mockRpc({ "settings.set": (params: { patch: { environment: { projectsDir: string | null } } }) => withDir(params.patch.environment.projectsDir ?? undefined) });
    render(<ProjectsDirGroup />);
    const input = screen.getByLabelText("Projects folder") as HTMLInputElement;
    expect(input.value).toBe("/home/me/code");
    expect(screen.getByText(/Where repos from other machines are cloned/)).toBeDefined();
    fireEvent.change(input, { target: { value: "~/repos" } });
    fireEvent.blur(input);
    await waitFor(() => expect(caller).toHaveBeenCalledWith("settings.set", { patch: { environment: { projectsDir: "~/repos" } } }));
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    await waitFor(() => expect(caller).toHaveBeenCalledWith("settings.set", { patch: { environment: { projectsDir: null } } }));
    await waitFor(() => expect(input.value).toBe(""));
    expect(input.placeholder).toBe("~/tide-projects");
  });

  it("edits another machine's folder after picking it", async () => {
    const caller = mockRpc({ "settings.set": () => withDir("/srv/repos") });
    render(<ProjectsDirGroup />);
    chooseOption("Machine", /^box/);
    const input = screen.getByLabelText("Projects folder") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: "/srv/repos" } });
    fireEvent.blur(input);
    await waitFor(() => expect(caller).toHaveBeenCalledWith("settings.set", { patch: { environment: { projectsDir: "/srv/repos" } } }, { envId: "env-b" }));
  });

  it("refuses a relative path", () => {
    expect(validateProjectsDir("code")).toMatch(/absolute/);
    expect(validateProjectsDir("~/code")).toBeUndefined();
    expect(validateProjectsDir("C:\\\\repos")).toBeUndefined();
    expect(validateProjectsDir("\\\\nas\\repos")).toBeUndefined();
    expect(validateProjectsDir("")).toBeUndefined();
  });
});
