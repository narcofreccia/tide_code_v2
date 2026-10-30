import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { App } from "../../App.tsx";
import { Rail } from "../shell/Rail.tsx";
import { ProjectCard } from "../mission/ProjectCard.tsx";
import { buildPaletteItems } from "../../lib/paletteItems.ts";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";
import { resetPrs } from "./prData.ts";
import { item, makePr } from "./testFixtures.ts";

afterEach(() => {
  cleanup();
  resetUi();
  resetPrs();
});

const PROJECT = { id: "p1", title: "App", rootPath: "/src/app", createdAt: 1, updatedAt: 1 };

function usage() {
  return { since: 0, until: 1, rows: [], days: [], notes: [], pricingVersion: "v1" };
}

describe("R10 routing", () => {
  it("#/prs and #/usage open their pages and set the document title", async () => {
    attachFakeStore(modelWith({ projects: { p1: PROJECT } }));
    mockRpc({ "pr.list": () => ({ items: [], fetchedAt: 1 }), "usage.summary": usage });
    window.history.replaceState(null, "", "#/prs");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Pull requests" })).toBeDefined();
    expect(document.title).toBe("Pull requests · Tide");

    await act(async () => {
      window.history.replaceState(null, "", "#/usage");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await screen.findByRole("heading", { name: "Usage" })).toBeDefined();
    expect(document.title).toBe("Usage · Tide");
  });

  it("the rail lists Pull requests with the open count, and Usage", async () => {
    attachFakeStore(
      modelWith({ projects: { p1: PROJECT }, threads: { t1: makeThread("t1", { pr: makePr(3) }), t2: makeThread("t2", { pr: makePr(4, { state: "merged" }) }) } }),
    );
    render(<Rail />);
    fireEvent.click(screen.getByRole("button", { name: "Pull requests · 1 open" }));
    expect(useUi.getState().view).toBe("prs");
    expect(useUi.getState().prsProjectId).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Usage" }));
    expect(useUi.getState().view).toBe("usage");
  });

  it("the rail count follows the loaded PR list once there is one", async () => {
    attachFakeStore(modelWith({ projects: { p1: PROJECT } }));
    mockRpc({ "pr.list": () => ({ items: [item(1), item(2), item(3, { state: "closed" })], fetchedAt: 1 }) });
    const { loadPrs } = await import("./prData.ts");
    await loadPrs({ state: "all" });
    render(<Rail />);
    expect(screen.getByRole("button", { name: "Pull requests · 2 open" })).toBeDefined();
  });

  it("the project card's PR count opens the PR tab filtered to the project", () => {
    attachFakeStore(modelWith({ projects: { p1: PROJECT }, threads: { t1: makeThread("t1", { pr: makePr(3) }) } }));
    render(<ProjectCard project={PROJECT} />);
    fireEvent.click(screen.getByRole("button", { name: "1 open pull requests in App" }));
    expect(useUi.getState().view).toBe("prs");
    expect(useUi.getState().prsProjectId).toBe("p1");
  });

  it("the palette offers both pages", () => {
    const items = buildPaletteItems({ model: modelWith({}), selectedThreadId: null });
    items.find((i) => i.id === "page:prs")?.run();
    expect(useUi.getState().view).toBe("prs");
    items.find((i) => i.id === "page:usage")?.run();
    expect(useUi.getState().view).toBe("usage");
  });
});
