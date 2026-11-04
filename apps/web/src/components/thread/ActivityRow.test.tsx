import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Activity } from "@tide/contracts";
import { ActivityRow } from "./ActivityRow.tsx";
import { setProvidersForTest } from "../../state/providers.ts";
import { useUi } from "../../state/ui.ts";
import { activeTab, resetWorkbench } from "../../state/workbench.ts";
import { resetVcs, useVcs } from "../../state/vcs.ts";
import { attachFakeStore, makeThread, makeTool, makeTurn, modelWith, modelWithTurns, resetUi } from "../../testHarness.ts";
import { LOGGED_OUT, PROVIDER_FIXTURE } from "../settings/fixtures.ts";

function errorActivity(text: string): Activity {
  return { id: "a1", threadId: "t1", turnId: "u1", createdAt: 1, updatedAt: 1, kind: "error", text };
}

function setup(): void {
  attachFakeStore(modelWith({ threads: { t1: makeThread("t1") } }));
}

afterEach(() => {
  cleanup();
  resetUi();
  resetVcs();
  resetWorkbench();
});

describe("error activities", () => {
  it("offers Settings › Providers and the harness login for an auth failure", () => {
    setup();
    setProvidersForTest([{ ...LOGGED_OUT, loginCommand: "claude /login" }, ...PROVIDER_FIXTURE.slice(1)]);
    render(
      <ul>
        <ActivityRow activity={errorActivity("API error 401: not logged in")} />
      </ul>,
    );

    expect(screen.getByText("Run login").getAttribute("title")).toBe("claude /login");
    fireEvent.click(screen.getByText("Open Settings › Providers"));
    expect(useUi.getState().view).toBe("settings");
    expect(useUi.getState().settingsSection).toBe("providers");
  });

  it("offers no login command when the harness is not installed", () => {
    setup();
    setProvidersForTest([
      { id: "claude", kind: "claude", label: "Claude Code", installed: false, loggedIn: false, hint: "install with `brew install claude`", models: [], caps: PROVIDER_FIXTURE[0]!.caps },
      ...PROVIDER_FIXTURE.slice(1),
    ]);
    render(
      <ul>
        <ActivityRow activity={errorActivity("401 unauthenticated")} />
      </ul>,
    );

    expect(screen.getByText("Open Settings › Providers")).toBeDefined();
    expect(screen.queryByText("Run login")).toBeNull();
  });

  it("leaves an ordinary error as a plain line", () => {
    setup();
    setProvidersForTest(PROVIDER_FIXTURE);
    render(
      <ul>
        <ActivityRow activity={errorActivity("ENOENT: no such file")} />
      </ul>,
    );

    expect(screen.getByText("ENOENT: no such file")).toBeDefined();
    expect(screen.queryByText("Open Settings › Providers")).toBeNull();
    expect(screen.queryByText("Run login")).toBeNull();
  });

  it("expands an unmodelled info event's raw payload", () => {
    setup();
    setProvidersForTest(PROVIDER_FIXTURE);
    const info: Activity = {
      id: "a2",
      threadId: "t1",
      turnId: "u1",
      createdAt: 1,
      updatedAt: 1,
      kind: "info",
      text: "harness: compaction",
      payload: { kind: "compaction", removed: 12 },
    };
    render(
      <ul>
        <ActivityRow activity={info} />
      </ul>,
    );

    const toggle = screen.getByRole("button", { name: "harness: compaction" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);

    expect(screen.getByText("payload")).toBeDefined();
    expect(screen.getByText(/"removed": 12/)).toBeDefined();
  });

  it("keeps a payload-less info line unexpandable", () => {
    setup();
    setProvidersForTest(PROVIDER_FIXTURE);
    const info: Activity = {
      id: "a3", threadId: "t1", turnId: "u1", createdAt: 1, updatedAt: 1, kind: "info", text: "just a note",
    };
    render(
      <ul>
        <ActivityRow activity={info} />
      </ul>,
    );
    expect(screen.queryByRole("button", { name: "just a note" })).toBeNull();
  });
});

describe("tool rows", () => {
  it("shows the first line of a command and the whole command on hover, status at the end", () => {
    setup();
    const command = "pnpm install\npnpm test --run";
    render(
      <ul>
        <ActivityRow activity={makeTool("a1", { toolName: "Bash", input: { command }, status: "ok", durationMs: 1200 })} />
      </ul>,
    );
    const target = screen.getByText("pnpm install");
    expect(target.getAttribute("title")).toBe(command);
    const row = target.closest("li")!;
    expect(screen.getByRole("img", { name: "done" })).toBeDefined();
    expect(row.textContent).toContain("1.2s");
  });

  it("summarises a JSON reply in one line and folds the pretty-printed raw payloads into the details", () => {
    setup();
    const output = '{"success":true,"message":"Resuming agent a1d3f1e","resumedAgentId":"a1"}';
    render(
      <ul>
        <ActivityRow activity={makeTool("a2", { toolName: "SendMessage", input: { to: "a1", message: "carry on" }, status: "ok", output })} />
      </ul>,
    );
    expect(screen.getByText("Resuming agent a1d3f1e")).toBeDefined();
    expect(screen.queryByText(output)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /SendMessage/ }));
    const pres = Array.from(document.querySelectorAll("pre")).map((p) => p.textContent);
    expect(pres).toContain(JSON.stringify(JSON.parse(output), null, 2));
    expect(pres).toContain(JSON.stringify({ to: "a1", message: "carry on" }, null, 2));
    expect(screen.getByRole("button", { name: "Copy output" })).toBeDefined();
  });
});


describe("edit rows — View diff", () => {
  it("opens the turn's diff in Changes when it has a checkpoint, leaving the path link for the editor", () => {
    const model = modelWithTurns(makeThread("t1"), [makeTurn("u1", { checkpoint: { before: "a", after: "b" } })], []);
    attachFakeStore(model);
    render(
      <ul>
        <ActivityRow activity={makeTool("a1", { toolName: "Edit", input: { file_path: "src/a.ts" }, status: "ok" })} />
      </ul>,
    );
    fireEvent.click(screen.getByLabelText(/View diff of/));
    expect(useVcs.getState().selection.t1).toBe("u1");
    expect(useVcs.getState().pickedFile.t1).toBe("src/a.ts");
    expect(activeTab("t1").kind).toBe("changes");
    fireEvent.click(screen.getByTitle("Open src/a.ts"));
    expect(activeTab("t1")).toMatchObject({ kind: "file", path: "src/a.ts" });
  });

  it("falls back to the editor without a checkpoint, and is absent on non-edit tools", () => {
    attachFakeStore(modelWithTurns(makeThread("t1"), [makeTurn("u1", { status: "completed" })], []));
    render(
      <ul>
        <ActivityRow activity={makeTool("a1", { toolName: "Edit", input: { file_path: "src/a.ts" }, status: "ok" })} />
        <ActivityRow activity={makeTool("a2", { toolName: "Read", input: { file_path: "src/b.ts" }, status: "ok" })} />
      </ul>,
    );
    expect(screen.getAllByLabelText(/View diff of/)).toHaveLength(1);
    fireEvent.click(screen.getByLabelText(/View diff of/));
    expect(activeTab("t1")).toMatchObject({ kind: "file", path: "src/a.ts" });
  });
});
