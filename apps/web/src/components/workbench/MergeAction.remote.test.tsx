import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../state/environments.ts", async () => (await import("../fleet/testEnvironments.ts")).fakeEnvironmentsModule());

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as envs from "../../state/environments.ts";
import { makeThread, resetUi } from "../../testHarness.ts";
import { twoMachines } from "../fleet/testEnvironments.ts";
import { MergeAction } from "./MergeAction.tsx";

const threadEnvs = (envs as unknown as { threadEnvs: Record<string, string> }).threadEnvs;
const thread = makeThread("t1", { worktreePath: "/wt/t1", branch: "tide/t1", baseBranch: "main" });

afterEach(() => {
  cleanup();
  resetUi();
  delete threadEnvs.t1;
});

function openPanel(): ReturnType<typeof within> {
  render(<MergeAction thread={thread} running={false} />);
  fireEvent.click(screen.getByText("Merge"));
  return within(screen.getByLabelText("Merge options"));
}

describe("Merge action — R17 remote thread", () => {
  it("says the merge runs and pushes on the owner machine", () => {
    envs.useEnvironments.setState(twoMachines());
    threadEnvs.t1 = "env-b";
    expect(openPanel().getByText("Merges on box and pushes main; pull on this machine afterwards")).toBeDefined();
  });

  it("says nothing extra for a thread on the primary", () => {
    envs.useEnvironments.setState(twoMachines());
    threadEnvs.t1 = "env-a";
    expect(openPanel().queryByText(/pull on this machine/)).toBeNull();
  });
});
