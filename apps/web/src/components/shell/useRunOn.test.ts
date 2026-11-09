import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

vi.mock("../../state/environments.ts", async () => (await import("../fleet/testEnvironments.ts")).fakeEnvironmentsModule());

import type { Project } from "@tide/contracts";
import * as envs from "../../state/environments.ts";
import { twoMachines } from "../fleet/testEnvironments.ts";
import { attachFakeStore, modelWith } from "../../testHarness.ts";
import { defaultUserSettings, resetServerSettings, useServerSettings } from "../../state/serverSettings.ts";
import { planRunOn, runOnCaption, settingsOfEnv, useRunOn } from "./useRunOn.ts";

const projectEnvs = (envs as unknown as { projectEnvs: Record<string, string> }).projectEnvs;
const repo = { remoteUrl: "github.com/acme/tide", cloneUrl: "https://github.com/acme/tide.git", defaultBranch: "main", detectedAt: 1 };
const base = (id: string, patch: Partial<Project> = {}): Project => ({ id, title: id, rootPath: `/src/${id}`, createdAt: 1, updatedAt: 1, ...patch });

afterEach(() => {
  resetServerSettings();
  envs.useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
  for (const key of Object.keys(projectEnvs)) delete projectEnvs[key];
});

describe("planRunOn", () => {
  const project = base("p1", { repo });
  const sibling = base("p2", { repo, title: "tide on box" });
  const ownerOf = (id: string): string | undefined => ({ p1: "a", p2: "b" })[id];

  it("the owner (or no target) runs on the project's own checkout", () => {
    expect(planRunOn({ project, siblings: [sibling], owner: "a", target: "a", ownerOf })).toEqual({ kind: "own" });
    expect(planRunOn({ project, siblings: [], owner: "a", target: undefined, ownerOf })).toEqual({ kind: "own" });
    expect(planRunOn({ project: base("p1"), siblings: [], owner: "a", target: "b", ownerOf })).toEqual({ kind: "own" });
  });

  it("a machine with a sibling clone uses it; one without clones", () => {
    expect(planRunOn({ project, siblings: [sibling], owner: "a", target: "b", ownerOf })).toEqual({ kind: "sibling", project: sibling });
    expect(planRunOn({ project, siblings: [sibling], owner: "a", target: "c", ownerOf, projectsDir: "~/code" })).toEqual({ kind: "clone", repo, projectsDir: "~/code" });
  });

  it("captions each plan", () => {
    expect(runOnCaption({ kind: "own" }, "box")).toEqual({ caption: "Runs on this machine's checkout" });
    expect(runOnCaption({ kind: "sibling", project: sibling }, "box").caption).toBe("Uses tide on box on box");
    expect(runOnCaption({ kind: "clone", repo }, "box")).toEqual({ caption: "Clones acme/tide onto box", note: "Linked repositories are not carried over" });
    expect(runOnCaption({ kind: "clone", repo, projectsDir: "~/tide-projects" }, "box").caption).toBe("Clones acme/tide onto box into ~/tide-projects");
  });
});

describe("settingsOfEnv", () => {
  it("reads the primary's mirror or another machine's entry, only once loaded", () => {
    const loaded = { ...defaultUserSettings(), environment: { name: "box", projectsDir: "/srv" } };
    const state = { ...useServerSettings.getState(), loaded: true, byEnv: { b: { settings: loaded, loaded: true }, c: { settings: loaded, loaded: false } } };
    expect(settingsOfEnv(state, "a", "a")).toBe(state.settings);
    expect(settingsOfEnv({ ...state, loaded: false }, "a", "a")).toBeUndefined();
    expect(settingsOfEnv(state, "b", "a")?.environment.projectsDir).toBe("/srv");
    expect(settingsOfEnv(state, "c", "a")).toBeUndefined();
  });
});

describe("useRunOn", () => {
  it("is pickable with a repo and two connected machines; the target defaults to the owner", () => {
    envs.useEnvironments.setState(twoMachines());
    projectEnvs["p1"] = "env-a";
    attachFakeStore(modelWith({ projects: { p1: base("p1", { repo }) } }));
    useServerSettings.setState({ byEnv: { "env-b": { settings: defaultUserSettings(), loaded: true } } });
    const { result } = renderHook(() => useRunOn("p1"));
    expect(result.current).toMatchObject({ pickable: true, owner: "env-a", target: "env-a", plan: { kind: "own" } });
    act(() => result.current.setTarget("env-b"));
    expect(result.current.plan).toEqual({ kind: "clone", repo, projectsDir: "~/tide-projects" });
    expect(result.current.caption).toBe("Clones acme/tide onto box into ~/tide-projects");
  });

  it("is not pickable without a repo", () => {
    envs.useEnvironments.setState(twoMachines());
    projectEnvs["p1"] = "env-a";
    attachFakeStore(modelWith({ projects: { p1: base("p1") } }));
    const { result } = renderHook(() => useRunOn("p1"));
    expect(result.current.pickable).toBe(false);
  });
});
