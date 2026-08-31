import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AddProjectForm } from "./AddProjectForm.tsx";
import { basename, breadcrumbs, FolderPicker } from "./FolderPicker.tsx";
import { attachFakeStore, mockRpc, modelWith, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

interface BrowseParams {
  path?: string;
  showHidden?: boolean;
}

const HOME = "/Users/dev";

function listing(path: string, dirs: { name: string; isGitRepo?: boolean }[], isGitRepo = false) {
  return {
    path,
    ...(path === "/" ? {} : { parent: path.split("/").slice(0, -1).join("/") || "/" }),
    home: HOME,
    isGitRepo,
    dirs: dirs.map((d) => ({ name: d.name, path: `${path}/${d.name}`, isGitRepo: d.isGitRepo === true })),
    recent: ["/Users/dev/tide"],
  };
}

/** Answers `fs.browse` from a table of directories, recording every request. */
function mockBrowse() {
  const calls: BrowseParams[] = [];
  const table: Record<string, ReturnType<typeof listing>> = {
    [HOME]: listing(HOME, [{ name: "tide", isGitRepo: true }, { name: "notes" }]),
    [`${HOME}/tide`]: listing(`${HOME}/tide`, [{ name: "apps" }], true),
  };
  mockRpc({
    "fs.browse": (params: never) => {
      const p = params as BrowseParams;
      calls.push(p);
      return table[p.path ?? HOME] ?? listing(p.path ?? HOME, []);
    },
  });
  return calls;
}

describe("breadcrumbs", () => {
  it("splits an absolute path into clickable segments", () => {
    expect(breadcrumbs("/Users/dev/tide")).toEqual([
      { label: "/", path: "/" },
      { label: "Users", path: "/Users" },
      { label: "dev", path: "/Users/dev" },
      { label: "tide", path: "/Users/dev/tide" },
    ]);
    expect(breadcrumbs("/")).toEqual([{ label: "/", path: "/" }]);
    expect(basename("/Users/dev/tide/")).toBe("tide");
  });
});

describe("FolderPicker", () => {
  it("lists the folders fs.browse reports, flagging git repos", async () => {
    mockBrowse();
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    const options = await screen.findAllByRole("option");
    // ".." plus the two directories
    expect(options.map((o) => o.textContent)).toEqual(["↑..", "⎇tide", "▸notes"]);
    expect(screen.getByRole("button", { name: "dev" })).toBeDefined();
  });

  it("navigates into a folder with the new path", async () => {
    const calls = mockBrowse();
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("option", { name: /tide/ }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toEqual({ path: `${HOME}/tide`, showHidden: false });
    await waitFor(() => expect(screen.getByRole("option", { name: /apps/ })).toBeDefined());
  });

  it("walks with the keyboard and goes up on Backspace", async () => {
    const calls = mockBrowse();
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    const list = await screen.findByRole("listbox", { name: "Folders" });
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    await waitFor(() => expect(calls[1]?.path).toBe(`${HOME}/notes`));
    fireEvent.keyDown(list, { key: "Backspace" });
    await waitFor(() => expect(calls[2]?.path).toBe(HOME));
  });

  it("re-browses with hidden folders when the toggle flips", async () => {
    const calls = mockBrowse();
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    await screen.findAllByRole("option");
    fireEvent.click(screen.getByLabelText("Show hidden folders", { selector: "input" }));
    await waitFor(() => expect(calls[1]).toEqual({ path: HOME, showHidden: true }));
  });

  it("offers the recent roots", async () => {
    const calls = mockBrowse();
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    await screen.findAllByRole("option");
    fireEvent.click(screen.getByRole("button", { name: "/Users/dev/tide" }));
    await waitFor(() => expect(calls[1]?.path).toBe("/Users/dev/tide"));
  });

  it("warns when the folder is not a git repository", async () => {
    mockBrowse();
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    expect(await screen.findByText(/Not a git repository/)).toBeDefined();
    fireEvent.click(screen.getByRole("option", { name: /tide/ }));
    await waitFor(() => expect(screen.queryByText(/Not a git repository/)).toBeNull());
  });
});

describe("Add a repository", () => {
  it("fills the path and names the project from the folder", async () => {
    attachFakeStore(modelWith({}));
    mockBrowse();
    render(<AddProjectForm onDone={() => undefined} />);
    expect(screen.getByText("Add a repository")).toBeDefined();
    expect(screen.getByText(/A project is a local git repository/)).toBeDefined();

    fireEvent.click(screen.getByText("Browse…"));
    fireEvent.click(await screen.findByRole("option", { name: /tide/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "tide" })).toBeDefined());
    fireEvent.click(screen.getByText("Use this folder"));

    expect(screen.getByLabelText<HTMLInputElement>("Project root path").value).toBe(`${HOME}/tide`);
    expect(screen.getByLabelText<HTMLInputElement>("Project title").value).toBe("tide");
  });

  it("keeps a title the user already typed", async () => {
    attachFakeStore(modelWith({}));
    mockBrowse();
    render(<AddProjectForm onDone={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Project title"), { target: { value: "Atlas" } });
    fireEvent.click(screen.getByText("Browse…"));
    await screen.findAllByRole("option");
    fireEvent.click(screen.getByText("Use this folder"));
    expect(screen.getByLabelText<HTMLInputElement>("Project title").value).toBe("Atlas");
    expect(screen.getByLabelText<HTMLInputElement>("Project root path").value).toBe(HOME);
  });

  it("still accepts a pasted absolute path", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<AddProjectForm onDone={() => undefined} />);
    fireEvent.change(screen.getByLabelText("Project title"), { target: { value: "Atlas" } });
    fireEvent.change(screen.getByLabelText("Project root path"), { target: { value: "/src/atlas" } });
    fireEvent.click(screen.getByText("Create"));
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "project.create",
      title: "Atlas",
      rootPath: "/src/atlas",
    });
  });
});
