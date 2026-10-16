import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CreateExpertsDialog } from "./CreateExpertsDialog.tsx";
import { EXPERT_PRESETS, presetByKey } from "../../lib/expertPresets.ts";
import { attachFakeStore, makeExpertsSession, modelWith, replyWithEvents, resetUi } from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

type Create = { experts: { key: string; name: string; persona?: string }[]; topic: string };

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function mount(id = "x1") {
  const fake = attachFakeStore(modelWith({}));
  replyWithEvents(fake, [{ type: "experts.created", session: makeExpertsSession(id) }]);
  render(<CreateExpertsDialog projectId="p1" onClose={() => undefined} />);
  return fake;
}

const primary = (): HTMLButtonElement => screen.getByRole("button", { name: /^Start with/ });
const names = (): string[] =>
  within(screen.getByRole("list", { name: "Experts" }))
    .getAllByRole("listitem")
    .map((li) => (li.querySelector("input") as HTMLInputElement | null)?.value ?? "")
    .filter((v) => v !== "");

describe("CreateExpertsDialog", () => {
  it("dispatches experts.create with the preset personas, then experts.start", async () => {
    const fake = mount();
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "  Shard the index  " } });
    fireEvent.click(screen.getByText("Start with 3 experts"));
    await settle();

    const create = fake.dispatch.mock.calls[0]?.[0];
    expect(create.type).toBe("experts.create");
    expect(create.projectId).toBe("p1");
    expect(create.topic).toBe("Shard the index");
    expect(create.lead).toEqual({ provider: "claude" });
    expect(create.experts.map((e: { key: string }) => e.key)).toEqual(["architect", "security", "maintainer"]);
    expect(create.experts[0].persona).toBe(presetByKey("architect")?.persona);
    expect(fake.dispatch).toHaveBeenNthCalledWith(2, { type: "experts.start", sessionId: "x1" });
    expect(useUi.getState().selectedExpertsSessionId).toBe("x1");
    expect(useUi.getState().view).toBe("experts");
  });

  it("focuses the topic on open", () => {
    mount();
    expect(document.activeElement).toBe(screen.getByLabelText("Topic"));
  });

  it("preset chips fill and trim the list", () => {
    mount();
    const chip = (name: string) => within(screen.getByRole("group", { name: "Presets" })).getByRole("button", { name });
    expect(chip("Architect").getAttribute("aria-pressed")).toBe("true");
    expect(chip("Performance").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(chip("Performance"));
    fireEvent.click(chip("Security"));
    expect(names()).toEqual(["Architect", "Maintainer", "Performance"]);
    expect(chip("Performance").getAttribute("aria-pressed")).toBe("true");
    expect(primary().textContent).toBe("Start with 3 experts");
  });

  it("offers every built-in persona as a chip", () => {
    mount();
    const chips = within(screen.getByRole("group", { name: "Presets" })).getAllByRole("button");
    expect(chips.map((c) => c.textContent?.slice(1))).toEqual(EXPERT_PRESETS.map((p) => p.name));
    expect(EXPERT_PRESETS).toHaveLength(6);
  });

  it("adds, edits, reorders and removes rows before starting", async () => {
    const fake = mount("x2");
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Topic" } });
    fireEvent.click(screen.getByRole("button", { name: "Add an expert" }));
    fireEvent.change(screen.getByLabelText("Expert 4 name"), { target: { value: "Skeptic" } });
    fireEvent.click(screen.getByLabelText("Remove Security"));
    fireEvent.change(screen.getByLabelText("Expert 1 name"), { target: { value: "Chief architect" } });
    fireEvent.click(screen.getByLabelText("Move Chief architect down"));
    fireEvent.click(screen.getByLabelText("Move Skeptic up"));
    fireEvent.click(screen.getByText("Start with 3 experts"));
    await settle();

    const create = fake.dispatch.mock.calls[0]?.[0] as Create;
    expect(create.experts.map((e) => e.name)).toEqual(["Maintainer", "Skeptic", "Chief architect"]);
    expect(create.experts[1]?.persona).toBeUndefined();
  });

  it("opens the persona editor with the default as placeholder and saves an edit", async () => {
    const fake = mount("x3");
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Topic" } });
    const card = screen.getByRole("listitem", { name: "Expert 2" });
    fireEvent.click(within(card).getByRole("button", { name: /Persona/ }));
    const editor = screen.getByLabelText("Expert 2 persona") as HTMLTextAreaElement;
    expect(editor.value).toBe("");
    expect(editor.placeholder).toBe(presetByKey("security")?.persona);
    fireEvent.change(editor, { target: { value: "  Only look at the auth flow.  " } });
    fireEvent.click(within(card).getByRole("button", { name: "Done" }));
    expect(screen.queryByLabelText("Expert 2 persona")).toBeNull();
    expect(within(card).getByText("Only look at the auth flow.")).toBeDefined();
    fireEvent.click(primary());
    await settle();
    const create = fake.dispatch.mock.calls[0]?.[0] as Create;
    expect(create.experts[1]?.persona).toBe("Only look at the auth flow.");
  });

  it("disables Start and says why", () => {
    const fake = mount();
    expect(primary().disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toBe("Add a topic to start");
    fireEvent.click(primary());
    expect(fake.dispatch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "x" } });
    for (const name of ["Architect", "Security", "Maintainer"]) fireEvent.click(screen.getByLabelText(`Remove ${name}`));
    expect(screen.getByRole("status").textContent).toBe("Add at least one expert");
  });

  it("⌘↵ starts from anywhere in the dialog", async () => {
    const fake = mount();
    const topic = screen.getByLabelText("Topic");
    fireEvent.change(topic, { target: { value: "Shard" } });
    fireEvent.keyDown(topic, { key: "Enter", metaKey: true });
    await settle();
    expect(fake.dispatch.mock.calls[0]?.[0]).toMatchObject({ type: "experts.create", topic: "Shard" });
  });

  it("scrolls the form body inside the dialog and keeps the actions outside it", () => {
    mount();
    const body = screen.getByTestId("experts-dialog-body");
    expect(body.className).toMatch(/body/);
    expect(body.contains(screen.getByLabelText("Topic"))).toBe(true);
    expect(body.contains(primary())).toBe(false);
  });
});
