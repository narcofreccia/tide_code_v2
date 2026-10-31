import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { attachFakeStore, makeThread, mockRpc, mockStream, modelWith, resetUi } from "../../../testHarness.ts";
import { resetRun } from "../../../state/run.ts";
import { activeTab } from "../../../state/workbench.ts";
import { useTerminals } from "../../../state/terminals.ts";
import { useUi } from "../../../state/ui.ts";
import { RpcCallError } from "@tide/client";
import { NO_PROFILES, RUN_UNSUPPORTED, RunPanel } from "./RunPanel.tsx";
import { installCommand, relativeCwd, splitCommand } from "./RunRow.tsx";
import { plan, planRow, project, repo, REPOS, session, status, svc } from "./fixtures.ts";

afterEach(() => {
  cleanup();
  resetRun();
  resetUi();
});

function setup(
  handlers: Parameters<typeof mockRpc>[0] = {},
  runStack?: { selected: string[]; pins: Record<string, number> },
  thread: Parameters<typeof makeThread>[1] = {},
) {
  const fake = attachFakeStore(modelWith({ projects: { p1: project(runStack === undefined ? {} : { runStack }) }, threads: { t1: makeThread("t1", thread) } }));
  const rpc = mockRpc({ "run.profiles.get": () => ({ repos: REPOS }), ...handlers });
  const { streams } = mockStream();
  render(<RunPanel projectId="p1" threadId="t1" />);
  const push = (chunk: unknown): void => act(() => streams.find((s) => s.method === "run.subscribe")?.push(chunk));
  return { fake, rpc, streams, push };
}

const row = (key: string): HTMLElement => document.querySelector(`[data-service="${key}"]`) as HTMLElement;

describe("RunPanel", () => {
  it("groups services by repo with source, stale and error, and defaults the selection", async () => {
    const { rpc } = setup();
    await screen.findByRole("region", { name: "backend" });
    expect(rpc).toHaveBeenCalledWith("run.profiles.get", { projectId: "p1" });
    const frontend = screen.getByRole("region", { name: "frontend" });
    expect(within(frontend).getByText("stale")).toBeDefined();
    expect(within(frontend).getByText("manifest")).toBeDefined();
    expect(screen.getByText("path missing on this machine: /src/gone")).toBeDefined();
    expect((screen.getByLabelText("Include api in the stack") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Include metro in the stack") as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText("0/3 up")).toBeDefined();
  });

  it("shows live states, moved ports and failure reasons from the session", async () => {
    const { push } = setup();
    await screen.findByRole("region", { name: "backend" });
    push({
      kind: "snapshot",
      session: session({
        "backend.api": status("running", { ports: { http: 8000 } }),
        "frontend.web": status("starting", { ports: { http: 8082 } }),
        "backend.redis": status("failed", { reason: "exited with code 1" }),
      }),
    });
    expect(within(row("backend.api")).getByRole("img", { name: "Running" })).toBeDefined();
    expect(within(row("frontend.web")).getByRole("img", { name: "Starting" })).toBeDefined();
    expect(within(row("frontend.web")).getByTitle("was 8081 → 8082").textContent).toBe(":8082");
    expect(within(row("backend.redis")).getByText("exited with code 1")).toBeDefined();
    expect(screen.getByText("1/3 up")).toBeDefined();
    push({ kind: "service", key: "backend.redis", status: status("external") });
    expect(within(row("backend.redis")).getByTitle("running outside Tide")).toBeDefined();
    push({ kind: "ended" });
    expect(screen.getByText("0/3 up")).toBeDefined();
  });

  it("Start stack plans the selection, shows the dialog and starts it", async () => {
    const { rpc } = setup({
      "run.plan": () => plan([planRow("backend.api", { ports: { http: 8000 } }), planRow("backend.redis"), planRow("frontend.web", { ports: { http: 8082 }, changedFrom: { http: 8081 }, env: { VITE_API_URL: "http://localhost:8000" } })]),
      "run.start": () => session({ "backend.api": status("starting") }),
    });
    await screen.findByRole("region", { name: "backend" });
    fireEvent.click(screen.getByRole("button", { name: /Start stack/ }));
    const dialog = await screen.findByRole("dialog", { name: "Start stack" });
    expect(rpc).toHaveBeenCalledWith("run.plan", { projectId: "p1", threadId: "t1", selected: ["backend.api", "backend.redis", "frontend.web"], pins: {} });
    expect(within(dialog).getByText("was 8081")).toBeDefined();
    expect(within(dialog).getByText("VITE_API_URL=http://localhost:8000")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Start 3 services" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(rpc).toHaveBeenCalledWith("run.start", { projectId: "p1", threadId: "t1", selected: ["backend.api", "backend.redis", "frontend.web"], pins: {} });
  });

  it("disables Start while blocked and re-plans when a conflicting service is deselected", async () => {
    const blocked = plan(
      [planRow("frontend.web", { ports: { http: 8081 } }), planRow("pos_app.metro", { ports: { http: 8081 }, blocked: "port 8081 taken by web" })],
      { status: "blocked", conflicts: [{ key: "pos_app.metro.http", port: 8081, with: "frontend.web.http", reason: "strict port" }] },
    );
    const { rpc, fake } = setup(
      {
        "run.plan": (params: { selected?: string[] }) =>
          params.selected?.includes("pos_app.metro") ? blocked : plan([planRow("frontend.web", { ports: { http: 8081 } })]),
      },
      { selected: ["frontend.web", "pos_app.metro"], pins: {} },
    );
    await screen.findByRole("region", { name: "backend" });
    fireEvent.click(screen.getByRole("button", { name: /Start stack/ }));
    const dialog = await screen.findByRole("dialog", { name: "Start stack" });
    expect((within(dialog).getByRole("button", { name: "Start 1 service" }) as HTMLButtonElement).disabled).toBe(true);
    const conflicts = within(dialog).getByRole("region", { name: "Conflicts" });
    expect(within(conflicts).getByText("metro")).toBeDefined();
    fireEvent.click(within(conflicts).getByRole("button", { name: "Deselect metro" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("run.plan", { projectId: "p1", threadId: "t1", selected: ["frontend.web"], pins: {} }));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "project.runStack.set", runStack: { selected: ["frontend.web"], pins: {} } }));
    await waitFor(() => expect((within(dialog).getByRole("button", { name: "Start 1 service" }) as HTMLButtonElement).disabled).toBe(false));
    expect(within(dialog).queryByRole("region", { name: "Conflicts" })).toBeNull();
  });

  it("pins a port from the dialog and re-plans with it", async () => {
    const { rpc } = setup({ "run.plan": () => plan([planRow("backend.api", { ports: { http: 8000 } })]) });
    await screen.findByRole("region", { name: "backend" });
    fireEvent.click(screen.getByRole("button", { name: /Start stack/ }));
    const dialog = await screen.findByRole("dialog", { name: "Start stack" });
    const input = within(dialog).getByLabelText("Port http of api");
    fireEvent.change(input, { target: { value: "9000" } });
    fireEvent.blur(input);
    await waitFor(() =>
      expect(rpc).toHaveBeenCalledWith("run.plan", expect.objectContaining({ pins: { "backend.api.http": 9000 } })),
    );
  });

  it("Preview opens the service's port; Logs focuses its terminal tab", async () => {
    const { push } = setup({
      "pty.list": () => ({ ptys: [{ ptyId: "rp-api", alive: true, label: "api" }, { ptyId: "rp-web", alive: true, label: "web" }] }),
    });
    await screen.findByRole("region", { name: "backend" });
    push({ kind: "snapshot", session: session({ "frontend.web": status("running", { ports: { http: 8082 } }) }) });
    fireEvent.click(screen.getByRole("button", { name: "Preview web" }));
    expect(activeTab("t1")).toEqual({ kind: "preview", url: "http://localhost:8082" });
    fireEvent.click(screen.getByRole("button", { name: "Logs of web" }));
    await waitFor(() => expect(useTerminals.getState().active.t1).toBe("rp-web"));
    expect(useTerminals.getState().drawerOpen).toBe(true);
  });

  it("starts, stops and restarts one service", async () => {
    const { rpc, push } = setup({
      "run.start": () => session({}),
      "run.stop": () => ({ ok: true }),
      "run.restart": () => session({}),
    });
    await screen.findByRole("region", { name: "backend" });
    fireEvent.click(screen.getByRole("button", { name: "Start redis" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("run.start", { projectId: "p1", threadId: "t1", selected: ["backend.redis"] }));
    push({ kind: "snapshot", session: session({ "backend.api": status("running") }) });
    fireEvent.click(screen.getByRole("button", { name: "Stop api" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart api" }));
    fireEvent.click(screen.getByRole("button", { name: /Stop all/ }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("run.restart", { projectId: "p1", key: "backend.api" }));
    expect(rpc).toHaveBeenCalledWith("run.stop", { projectId: "p1", key: "backend.api" });
    expect(rpc).toHaveBeenCalledWith("run.stop", { projectId: "p1" });
  });

  it("offers Scan / Ask the model / settings when no repo has a profile", async () => {
    const scanned = repo("root", "backend", [svc("api")], { label: "backend" });
    const { rpc } = setup({
      "run.profiles.get": () => ({ repos: [repo("root", "backend", undefined)] }),
      "run.profiles.scan": () => scanned,
    });
    await screen.findByText(NO_PROFILES);
    fireEvent.click(screen.getByRole("button", { name: "Ask the model" }));
    await waitFor(() => expect(rpc).toHaveBeenCalledWith("run.profiles.scan", { projectId: "p1", repoId: "root", useModel: true }));
    await screen.findByLabelText("Include api in the stack");
    // "Open run settings" lives in the empty state and the menu
    fireEvent.click(screen.getByRole("button", { name: "More run actions" }));
    fireEvent.click(screen.getByRole("button", { name: "Open run settings" }));
    expect(useUi.getState().view).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("projects");
  });

  it("degrades to a quiet note on a server without run.* and hides Start stack", async () => {
    setup({
      "run.profiles.get": () => {
        throw new RpcCallError({ code: "method-not-found", message: "unknown method run.profiles.get" });
      },
    });
    const note = await screen.findByText(RUN_UNSUPPORTED);
    expect(note.className).not.toMatch(/Error/);
    expect(screen.queryByText(/Could not load run profiles/)).toBeNull();
    expect(screen.queryByRole("button", { name: /Start stack/ })).toBeNull();
  });

  it("keeps other load errors as a wrapped error line", async () => {
    setup({
      "run.profiles.get": () => {
        throw new RpcCallError({ code: "internal", message: "boom" });
      },
    });
    const line = await screen.findByText("Could not load run profiles: boom");
    expect(line.className).toMatch(/loadError/);
    expect(screen.getByRole("button", { name: /Start stack/ })).toBeDefined();
  });

  it("shows the command middle-ellipsised with the full title, env chips, and a wrapping header", async () => {
    const long = "uv run uvicorn app.main:app --reload --host 0.0.0.0 --port 8000";
    setup({
      "run.profiles.get": () => ({ repos: [repo("root", "backend", [svc("api", { command: long, env: { DEBUG: "1" } })])] }),
    });
    await screen.findByRole("region", { name: "backend" });
    const cmd = within(row("backend.api")).getByTitle(long);
    expect(cmd.className).toMatch(/command/);
    expect(cmd.querySelector("[class*=commandHead]")?.textContent).toBe(splitCommand(long).head);
    expect(cmd.querySelector("[class*=commandTail]")?.textContent).toBe(long.slice(-14));
    expect(within(row("backend.api")).getByText("DEBUG=1").className).toMatch(/envChip/);
    const actions = screen.getByLabelText("Run stack").querySelector("[class*=headerActions]") as HTMLElement;
    expect(within(actions).getByRole("button", { name: /Start stack/ })).toBeDefined();
    expect(splitCommand("pnpm dev")).toEqual({ head: "pnpm dev", tail: "" });
  });

  describe("worktree root", () => {
    const WT = { worktreePath: "/wt/feat", branch: "tide/feat" };

    it("shows the thread's branch, or the main checkout, and the running stack's root once it runs", async () => {
      const { push } = setup({}, undefined, WT);
      await screen.findByRole("region", { name: "backend" });
      const header = screen.getByLabelText("Run stack").querySelector("[class*=headerTitle]") as HTMLElement;
      const pill = within(header).getByTitle("the project's own repo runs from this thread's worktree");
      expect(pill.textContent).toBe("tide/feat");
      push({ kind: "snapshot", session: session({ "backend.api": status("running") }) });
      expect(pill.textContent).toBe("main checkout");
      cleanup();
      setup();
      await screen.findByRole("region", { name: "backend" });
      expect(screen.getByTitle("the project's own repo runs from this thread's worktree").textContent).toBe("main checkout");
    });

    it("the dialog shows the branch and root rows' cwd under the worktree; Stop that stack stops and re-plans", async () => {
      let running = true;
      const rows = [planRow("backend.api", { cwd: "/wt/feat/server" }), planRow("frontend.web", { repoId: "l1", cwd: "/src/frontend" })];
      const { rpc } = setup(
        {
          "run.plan": () =>
            plan(rows, {
              rootPath: "/wt/feat",
              rootBranch: "tide/feat",
              ...(running
                ? { status: "blocked" as const, conflicts: [{ key: "backend.*", port: 0, with: "main checkout", reason: "stack already running from main checkout; stop it first" }] }
                : {}),
            }),
          "run.stop": () => {
            running = false;
            return { ok: true };
          },
        },
        undefined,
        WT,
      );
      await screen.findByRole("region", { name: "backend" });
      fireEvent.click(screen.getByRole("button", { name: /Start stack/ }));
      const dialog = await screen.findByRole("dialog", { name: "Start stack" });
      expect(within(dialog).getByTitle("the project's own repo runs from this thread's worktree").textContent).toBe("tide/feat");
      expect(within(dialog).getByTitle("/wt/feat/server").textContent).toBe("server");
      expect(within(dialog).queryByTitle("/src/frontend")).toBeNull();
      const conflicts = within(dialog).getByRole("region", { name: "Conflicts" });
      expect(within(conflicts).getByText("stack already running from main checkout; stop it first")).toBeDefined();
      fireEvent.click(within(conflicts).getByRole("button", { name: /Stop that stack/ }));
      await waitFor(() => expect(within(dialog).queryByRole("region", { name: "Conflicts" })).toBeNull());
      expect(rpc).toHaveBeenCalledWith("run.stop", { projectId: "p1" });
      expect(rpc.mock.calls.filter(([m]) => m === "run.plan")).toHaveLength(2);
      expect((within(dialog).getByRole("button", { name: "Start 2 services" }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("a missing-dependencies failure offers the install command to copy", async () => {
      const { push } = setup({}, undefined, WT);
      await screen.findByRole("region", { name: "backend" });
      push({
        kind: "snapshot",
        session: session(
          { "backend.api": status("failed", { reason: "dependencies missing in this worktree — run the install step (e.g. npm install) there first" }) },
          { worktree: { threadId: "t1", path: "/wt/feat", branch: "tide/feat" }, plan: plan([planRow("backend.api", { cwd: "/wt/feat/api" })], { rootPath: "/wt/feat" }) },
        ),
      });
      const api = row("backend.api");
      expect(within(api).getByText(/dependencies missing in this worktree/)).toBeDefined();
      const cmd = 'cd "/wt/feat/api" && python -m venv venv && source venv/bin/activate && pip install -r requirements.txt';
      expect(within(api).getByRole("button", { name: `Copy ${cmd}` })).toBeDefined();
      expect(within(api).getByTitle("/wt/feat/api").textContent).toBe("api");
      expect(within(row("frontend.web")).queryByRole("button", { name: /^Copy / })).toBeNull();
    });

    it("picks the install command by kind and runner; cwd relative to the root", () => {
      expect(installCommand(svc("web", { kind: "vite", command: "pnpm dev" }))).toBe("pnpm install");
      expect(installCommand(svc("web", { kind: "node", command: "node server.js" }), "/wt/a")).toBe('cd "/wt/a" && npm install');
      expect(relativeCwd("/wt/a", "/wt/a/")).toBe(".");
      expect(relativeCwd("/wt/a/web", "/wt/a")).toBe("web");
      expect(relativeCwd("/src/x", "/wt/a")).toBeUndefined();
    });
  });
});
