import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { emptyReadModel } from "@tide/contracts";
import { Rail } from "./Rail.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { useModel } from "../../state/model.ts";
import { useEnvironments } from "../../state/envStore.ts";

afterEach(() => {
  cleanup();
  resetUi();
  useEnvironments.setState({ environments: [], statuses: {}, primaryId: undefined });
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

describe("Rail before the first snapshot", () => {
  it("shows a skeleton, then the Add a repository card once the server answered empty", () => {
    attachFakeStore(emptyReadModel());
    act(() => useModel.setState({ ready: false }));
    render(<Rail />);
    expect(screen.getByRole("status", { name: "Loading threads" })).toBeDefined();
    expect(screen.queryByText("Add a repository")).toBeNull();
    act(() => useModel.setState({ ready: true }));
    expect(screen.queryByRole("status", { name: "Loading threads" })).toBeNull();
    expect(screen.getByText("Add a repository")).toBeDefined();
  });

  it("shows a skeleton, then the threads", () => {
    attachFakeStore(emptyReadModel());
    act(() => useModel.setState({ ready: false }));
    render(<Rail />);
    act(() =>
      useModel.setState({ ready: true, model: modelWith({ projects: { p1: project }, threads: { t1: makeThread("t1", { title: "First thread" }) } }) }),
    );
    expect(screen.queryByRole("status", { name: "Loading threads" })).toBeNull();
    expect(screen.getByText("First thread")).toBeDefined();
  });
});

describe("Rail rows of an offline machine", () => {
  it("are muted and say so on hover; the primary's rows are not", () => {
    attachFakeStore(
      modelWith({
        projects: { p1: project },
        threads: { t1: makeThread("t1", { title: "Here" }), t2: makeThread("t2", { title: "There" }) },
      }),
    );
    const route = (id: string) => [{ kind: "lan" as const, url: `ws://${id}:3777/ws`, priority: 1 }];
    act(() => {
      useEnvironments.setState({
        environments: [
          { id: "here", name: "laptop", routes: route("here"), addedAt: 1 },
          { id: "studio", name: "studio-mac", routes: route("studio"), addedAt: 1 },
        ],
        primaryId: "here",
        statuses: { here: { connection: "connected" }, studio: { connection: "offline" } },
      });
      useModel.setState({ ownership: { projects: { p1: "here" }, threads: { t1: "here", t2: "studio" } } });
    });
    const { container } = render(<Rail />);
    const row = (id: string) => container.querySelector(`[data-rail-thread="${id}"]`);
    expect(row("t2")?.hasAttribute("data-offline")).toBe(true);
    expect(row("t2")?.querySelector("[data-rail-main]")?.getAttribute("title")).toContain("studio-mac is offline");
    expect(row("t1")?.hasAttribute("data-offline")).toBe(false);
  });
});
