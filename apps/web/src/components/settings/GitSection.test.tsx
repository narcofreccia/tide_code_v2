import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { GitSection } from "./GitSection.tsx";
import { attachFakeStore, mockRpc, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Settings › Git", () => {
  it("shows the worktree root the server reports", async () => {
    attachFakeStore(modelWith({}));
    mockRpc({
      "server.info": () => ({
        version: "0.0.0",
        environmentId: "env-1",
        tideHome: "/srv/tide",
        worktreeRoot: "/srv/tide/worktrees",
      }),
    });
    render(<GitSection />);

    expect(await screen.findByText("/srv/tide/worktrees")).toBeDefined();
    expect(screen.queryByText(/reads it from the server once/)).toBeNull();
  });

  it("falls back to the documented default until server.info answers", async () => {
    attachFakeStore(modelWith({}));
    mockRpc({ "server.info": () => ({ version: "0.0.0", environmentId: "env-1" }) });
    render(<GitSection />);

    await waitFor(() => expect(screen.getByText("~/.tide/worktrees")).toBeDefined());
  });
});
