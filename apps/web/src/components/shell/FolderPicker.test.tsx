import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { AddProjectForm } from "./AddProjectForm.tsx";
import { FolderPicker } from "./FolderPicker.tsx";
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

  it("renders no drive row when the server sends no roots (POSIX)", async () => {
    mockBrowse();
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    await screen.findAllByRole("option");
    expect(screen.queryByRole("navigation", { name: "Drives" })).toBeNull();
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
    expect(screen.getByText(/A local git repository/)).toBeDefined();

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

describe("New project", () => {
  it("creates the folder through project.init and selects the project", async () => {
    attachFakeStore(modelWith({}));
    const calls: unknown[] = [];
    mockBrowse();
    mockRpc({
      "fs.browse": (p: never) => listing((p as BrowseParams).path ?? HOME, [{ name: "notes" }]),
      "project.init": (params: never) => {
        calls.push(params);
        return { projectId: "p-new", rootPath: `${HOME}/my-app` };
      },
    });
    render(<AddProjectForm onDone={() => undefined} />);
    fireEvent.click(screen.getByLabelText("New project"));
    expect(screen.getByText(/runs git init/)).toBeDefined();
    fireEvent.click(screen.getByText("Browse…"));
    await screen.findAllByRole("option");
    expect(screen.getByText("Choose where to create the project")).toBeDefined();
    fireEvent.click(screen.getByText("Create here"));
    expect(screen.getByLabelText<HTMLInputElement>("Parent folder").value).toBe(HOME);
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "my app" } });
    fireEvent.click(screen.getByText("Create project"));
    expect(screen.getByText(/letters, digits/)).toBeDefined();
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "my-app" } });
    fireEvent.click(screen.getByText("Create project"));
    await waitFor(() => expect(calls).toEqual([{ parentPath: HOME, name: "my-app" }]));
  });
});

/** A Windows host: `fs.browse` answers with drive paths, as `node:path` on win32 does. */
function mockWindowsBrowse(extra: Record<string, (params: never) => unknown> = {}, roots?: string[]) {
  const calls: BrowseParams[] = [];
  const winListing = (path: string, dirs: string[], parent?: string) => ({
    path,
    ...(parent === undefined ? {} : { parent }),
    home: "C:\\Users\\andre",
    isGitRepo: false,
    dirs: dirs.map((name) => ({ name, path: `${path.replace(/\\$/, "")}\\${name}`, isGitRepo: false })),
    recent: [],
    ...(roots === undefined ? {} : { roots }),
  });
  const table: Record<string, ReturnType<typeof winListing>> = {
    "C:\\": winListing("C:\\", ["Users"]),
    "D:\\": winListing("D:\\", ["work"]),
    "C:\\Users": winListing("C:\\Users", ["andre"], "C:\\"),
    "C:\\Users\\andre": winListing("C:\\Users\\andre", ["Desktop"], "C:\\Users"),
    "C:\\Users\\andre\\Desktop": winListing("C:\\Users\\andre\\Desktop", [], "C:\\Users\\andre"),
  };
  mockRpc({
    "fs.browse": (params: never) => {
      const p = params as BrowseParams;
      calls.push(p);
      const hit = table[p.path ?? "C:\\Users\\andre"];
      if (!hit) throw new Error(`no such directory: ${p.path}`);
      return hit;
    },
    ...extra,
  });
  return calls;
}

describe("FolderPicker on a Windows server", () => {
  it("shows drive-path crumbs that browse real Windows paths", async () => {
    const calls = mockWindowsBrowse();
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    await screen.findByRole("option", { name: /Desktop/ });
    const crumbs = within(screen.getByRole("navigation", { name: "Path" })).getAllByRole("button");
    expect(crumbs.map((c) => c.textContent)).toEqual(["C:", "Users", "andre"]);
    fireEvent.click(screen.getByRole("button", { name: "Users" }));
    await waitFor(() => expect(calls[1]?.path).toBe("C:\\Users"));
    fireEvent.click(await screen.findByRole("button", { name: "C:" }));
    await waitFor(() => expect(calls[2]?.path).toBe("C:\\"));
    // the drive root has no parent: no ".." row
    await screen.findByRole("option", { name: /Users/ });
    expect(screen.queryByRole("option", { name: /\.\./ })).toBeNull();
  });

  it("goes up one folder with the server's parent", async () => {
    const calls = mockWindowsBrowse();
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    fireEvent.click(await screen.findByRole("option", { name: /\.\./ }));
    await waitFor(() => expect(calls[1]?.path).toBe("C:\\Users"));
  });

  it("offers the server's drives, marks the current one and browses another", async () => {
    const calls = mockWindowsBrowse({}, ["C:\\", "D:\\"]);
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    await screen.findByRole("option", { name: /Desktop/ });
    const drives = within(screen.getByRole("navigation", { name: "Drives" })).getAllByRole("button");
    expect(drives.map((d) => d.textContent)).toEqual(["C:", "D:"]);
    expect(drives.map((d) => d.getAttribute("aria-current"))).toEqual(["true", null]);
    fireEvent.click(drives[1]!);
    await waitFor(() => expect(calls[1]?.path).toBe("D:\\"));
    await screen.findByRole("option", { name: /work/ });
    const after = within(screen.getByRole("navigation", { name: "Drives" })).getAllByRole("button");
    expect(after.map((d) => d.getAttribute("aria-current"))).toEqual([null, "true"]);
  });

  it("renders no drive row for a single root", async () => {
    mockWindowsBrowse({}, ["C:\\"]);
    render(<FolderPicker onPick={() => undefined} onClose={() => undefined} />);
    await screen.findByRole("option", { name: /Desktop/ });
    expect(screen.queryByRole("navigation", { name: "Drives" })).toBeNull();
  });
});

describe("Add project with Windows paths", () => {
  it("creates a new project under a picked Windows parent folder", async () => {
    attachFakeStore(modelWith({}));
    const calls: unknown[] = [];
    mockWindowsBrowse({
      "project.init": (params: never) => {
        calls.push(params);
        return { projectId: "p-new", rootPath: "C:\\Users\\andre\\Desktop\\my-app" };
      },
    });
    render(<AddProjectForm onDone={() => undefined} />);
    fireEvent.click(screen.getByLabelText("New project"));
    fireEvent.click(screen.getByText("Browse…"));
    fireEvent.click(await screen.findByRole("option", { name: /Desktop/ }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Desktop" })).toBeDefined());
    fireEvent.click(screen.getByText("Create here"));
    expect(screen.getByLabelText<HTMLInputElement>("Parent folder").value).toBe("C:\\Users\\andre\\Desktop");
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "my-app" } });
    fireEvent.click(screen.getByText("Create project"));
    await waitFor(() => expect(calls).toEqual([{ parentPath: "C:\\Users\\andre\\Desktop", name: "my-app" }]));
    expect(screen.queryByText(/must be absolute/)).toBeNull();
  });

  it.each(["C:\\", "D:/work", "\\\\nas\\projects"])("accepts the typed parent %s", async (parent) => {
    attachFakeStore(modelWith({}));
    const calls: unknown[] = [];
    mockRpc({
      "project.init": (params: never) => {
        calls.push(params);
        return { projectId: "p-new", rootPath: `${parent}\\my-app` };
      },
    });
    render(<AddProjectForm onDone={() => undefined} />);
    fireEvent.click(screen.getByLabelText("New project"));
    fireEvent.change(screen.getByLabelText("Parent folder"), { target: { value: parent } });
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "my-app" } });
    fireEvent.click(screen.getByText("Create project"));
    await waitFor(() => expect(calls).toEqual([{ parentPath: parent, name: "my-app" }]));
    expect(screen.queryByText(/must be absolute/)).toBeNull();
  });

  it("still refuses a relative parent", () => {
    attachFakeStore(modelWith({}));
    render(<AddProjectForm onDone={() => undefined} />);
    fireEvent.click(screen.getByLabelText("New project"));
    fireEvent.change(screen.getByLabelText("Parent folder"), { target: { value: "Desktop" } });
    fireEvent.change(screen.getByLabelText("Folder name"), { target: { value: "my-app" } });
    fireEvent.click(screen.getByText("Create project"));
    expect(screen.getByText("Parent path must be absolute")).toBeDefined();
  });

  it("adds an existing repository at a typed Windows path, named from its folder", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<AddProjectForm onDone={() => undefined} />);
    const input = screen.getByLabelText("Project root path");
    fireEvent.change(input, { target: { value: "C:\\src\\atlas\\" } });
    fireEvent.blur(input);
    expect(screen.getByLabelText<HTMLInputElement>("Project title").value).toBe("atlas");
    fireEvent.click(screen.getByText("Create"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.create", title: "atlas", rootPath: "C:\\src\\atlas\\" });
  });
});
