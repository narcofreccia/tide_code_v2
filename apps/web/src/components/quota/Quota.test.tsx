import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { quotaView } from "@tide/client";
import type { Project, QuotaState, Thread } from "@tide/contracts";
import { attachFakeStore, chooseOption, makeThread, makeTurn, modelWith, modelWithTurns, resetUi } from "../../testHarness.ts";
import { resetDrafts } from "../../state/drafts.ts";
import { Composer } from "../thread/Composer.tsx";
import { MissionControl } from "../mission/MissionControl.tsx";
import { QuotaEditor } from "./QuotaEditor.tsx";
import { QuotaMeter } from "./QuotaMeter.tsx";
import { QuotaDialogHost, useQuotaDialog } from "./QuotaDialog.tsx";

afterEach(() => {
  cleanup();
  resetUi();
  resetDrafts();
  useQuotaDialog.setState({ target: null });
});

const DAY = 86_400_000;

const project = (patch: Partial<Project> = {}): Project => ({ id: "p1", title: "Side project", rootPath: "/p1", createdAt: 1, updatedAt: 1, ...patch });

const exceeded = (patch: Partial<QuotaState> = {}): QuotaState => ({
  status: "exceeded",
  usedPct: 103.4,
  basis: "share",
  over: ["claude"],
  windowEndsAt: Date.now() + 2 * DAY + 60_000,
  at: 1,
  ...patch,
});

const held = project({ quota: { sharePct: 30, onExceed: "hold" }, quotaState: exceeded() });

describe("QuotaEditor", () => {
  it("needs a cap, checks the share, and saves through quota.set", () => {
    const fake = attachFakeStore(modelWith({ projects: { p1: project() } }));
    render(<QuotaEditor scope="project" entity={project()} startOn />);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toBe("Set a share, an amount, or both.");
    fireEvent.change(screen.getByLabelText("Share of the weekly window"), { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByRole("alert").textContent).toBe("The share is a percent from 1 to 100.");
    expect(fake.dispatch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Share of the weekly window"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Amount per week"), { target: { value: "20" } });
    chooseOption("At the cap", /^Warn only/);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "quota.set", scope: "project", id: "p1", quota: { sharePct: 30, usdPerWeek: 20, onExceed: "warn" } }),
    );
  });

  it("removes a quota with quota.set and no quota", () => {
    const fake = attachFakeStore(modelWith({ projects: { p1: held } }));
    render(<QuotaEditor scope="project" entity={held} />);
    expect(screen.getByLabelText("Share of the weekly window")).toHaveProperty("value", "30");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const command = fake.dispatch.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(command).toMatchObject({ type: "quota.set", scope: "project", id: "p1" });
    expect("quota" in command).toBe(false);
  });

  it("is read-only for a device with limited access, and says why", () => {
    const reason = "This device has limited access. Turn on Full access for it on studio.";
    attachFakeStore(modelWith({ projects: { p1: held } }));
    render(<QuotaEditor scope="project" entity={held} limit={reason} />);
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Remove" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Share of the weekly window") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("switch") as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText(reason)).toBeDefined();
  });

  it("opens from the thread menu's dialog for a thread quota", () => {
    const thread = makeThread("t1", { title: "Spike" });
    const fake = attachFakeStore(modelWith({ threads: { t1: thread } }));
    render(<QuotaDialogHost />);
    expect(screen.queryByRole("dialog")).toBeNull();
    useQuotaDialog.getState().open("thread", "t1");
    cleanup();
    render(<QuotaDialogHost />);
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Amount per week"), { target: { value: "5" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "quota.set", scope: "thread", id: "t1", quota: { usdPerWeek: 5, onExceed: "hold" } }));
    expect(useQuotaDialog.getState().target).toBeNull();
  });
});

describe("QuotaMeter", () => {
  it.each([
    ["ok", { status: "ok" as const, usedPct: 20 }],
    ["warning", { status: "warning" as const, usedPct: 85 }],
    ["exceeded", { status: "exceeded" as const, usedPct: 104 }],
  ])("takes the %s tone", (tone, patch) => {
    const view = quotaView("project", project({ quota: { sharePct: 30, onExceed: "hold" }, quotaState: exceeded(patch) }))!;
    render(<QuotaMeter view={view} />);
    const meter = screen.getByLabelText("Quota of Side project");
    expect(meter.getAttribute("data-tone")).toBe(tone);
    expect(Number(meter.getAttribute("value"))).toBe(Math.min(100, patch.usedPct));
  });

  it("says measuring right after a change, before the server measures", () => {
    const view = quotaView("project", project({ quota: { sharePct: 30, onExceed: "hold" } }))!;
    render(<QuotaMeter view={view} />);
    expect(screen.getByLabelText("Quota of Side project").getAttribute("data-tone")).toBe("measuring");
    expect(screen.getByText("quota · measuring")).toBeDefined();
  });

  it("renders nothing new on a project card without a quota", () => {
    attachFakeStore(modelWith({ projects: { p1: project() }, threads: { t1: makeThread("t1") } }));
    render(<MissionControl />);
    expect(screen.queryByLabelText("Quota of Side project")).toBeNull();
    expect(screen.queryByLabelText("Held by quota")).toBeNull();
  });
});

describe("a held project", () => {
  it("Mission Control lists it with Lift until reset and Edit quota", () => {
    const fake = attachFakeStore(modelWith({ projects: { p1: held }, threads: { t1: makeThread("t1"), t2: makeThread("t2") } }));
    render(<MissionControl />);
    const section = screen.getByLabelText("Held by quota");
    expect(section.textContent).toContain("Side project");
    expect(section.textContent).toContain("Held by quota · 2 threads · resets in 2d");
    fireEvent.click(within(section).getByRole("button", { name: "Lift until reset" }));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "quota.lift", scope: "project", id: "p1" }));
    fireEvent.click(within(section).getByRole("button", { name: "Edit quota" }));
    expect(useQuotaDialog.getState().target).toEqual({ scope: "project", id: "p1" });
    // the card's meter shows the exceeded tone
    expect(screen.getAllByLabelText("Quota of Side project")[0]?.getAttribute("data-tone")).toBe("exceeded");
  });

  it("the composer is held: send off with the reason, a block with Lift until reset", () => {
    const thread: Thread = makeThread("t1", { latestTurnId: "u1" });
    const model = modelWithTurns(thread, [makeTurn("u1")]);
    model.projects.p1 = held;
    const fake = attachFakeStore(model);
    render(<Composer thread={thread} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "more" } });
    const send = screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe("Project quota reached (≈ 31% of the weekly window, cap 30%).");
    const block = screen.getByLabelText("Quota reached");
    expect(block.textContent).toContain("Project quota reached (≈ 31% of the weekly window, cap 30%) · resets in 2d");
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(fake.dispatch).not.toHaveBeenCalled();
    fireEvent.click(within(block).getByRole("button", { name: "Lift until reset" }));
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "quota.lift", scope: "project", id: "p1" }));
  });

  it("labels the queued turns of an idle held thread", () => {
    const thread: Thread = makeThread("t1", { latestTurnId: "u1" });
    const model = modelWithTurns(thread, [makeTurn("u1"), makeTurn("u2", { status: "queued" })]);
    model.projects.p1 = held;
    attachFakeStore(model);
    render(<Composer thread={thread} />);
    expect(within(screen.getByLabelText("Queued messages")).getByText("Held by quota")).toBeDefined();
  });
});
