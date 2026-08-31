import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import type { Project, ProjectLink } from "@tide/contracts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { ThreadLinkChips } from "./ThreadLinkChips.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const links: ProjectLink[] = [
  { id: "web", path: "/src/web", label: "Web client", note: "React app", access: "write" },
  { id: "docs", path: "/src/docs", label: "Docs", access: "read" },
];

function attach(threadLinks?: { linkId: string; access: "read" | "write" }[]): void {
  const project: Project = { id: "p1", title: "Tide", rootPath: "/src/tide", links, createdAt: 1, updatedAt: 1 };
  attachFakeStore(
    modelWith({
      projects: { p1: project },
      threads: { t1: makeThread("t1", threadLinks === undefined ? {} : { links: threadLinks }) },
    }),
  );
}

describe("ThreadLinkChips", () => {
  it("renders one chip per link with its access, path and note on hover", () => {
    attach([
      { linkId: "web", access: "read" },
      { linkId: "docs", access: "read" },
    ]);
    render(<ThreadLinkChips threadId="t1" />);

    const chips = within(screen.getByLabelText("Linked repositories")).getAllByRole("listitem");
    expect(chips).toHaveLength(2);
    expect(chips[0]?.textContent).toContain("Web client");
    expect(chips[0]?.textContent).toContain("ro");
    expect(chips[0]?.getAttribute("title")).toBe("/src/web — React app");
    expect(chips[1]?.getAttribute("title")).toBe("/src/docs");
  });

  it("falls back to the project's links at their default access", () => {
    attach();
    render(<ThreadLinkChips threadId="t1" />);
    const text = screen.getByLabelText("Linked repositories").textContent ?? "";
    expect(text).toContain("Web client");
    expect(text).toContain("rw");
    expect(text).toContain("ro");
  });

  it("renders nothing when the project has no links", () => {
    attachFakeStore(
      modelWith({
        projects: { p1: { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 } },
        threads: { t1: makeThread("t1") },
      }),
    );
    const { container } = render(<ThreadLinkChips threadId="t1" />);
    expect(container.firstChild).toBeNull();
  });
});
