import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { CreateExpertsDialog } from "./CreateExpertsDialog.tsx";
import { EXPERT_PRESETS, presetByKey } from "../../lib/expertPresets.ts";
import {
  attachFakeStore,
  chooseOption,
  makeExpertsSession,
  modelWith,
  optionLabels,
  replyWithEvents,
  resetUi,
} from "../../testHarness.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("CreateExpertsDialog", () => {
  it("dispatches experts.create with the preset personas, then experts.start", async () => {
    const fake = attachFakeStore(modelWith({}));
    replyWithEvents(fake, [{ type: "experts.created", session: makeExpertsSession("x1") }]);
    render(<CreateExpertsDialog projectId="p1" onClose={() => undefined} />);

    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "  Shard the index  " } });
    fireEvent.click(screen.getByText("Start"));
    await Promise.resolve();
    await Promise.resolve();

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

  it("adds, edits, reorders and removes rows before starting", async () => {
    const fake = attachFakeStore(modelWith({}));
    replyWithEvents(fake, [{ type: "experts.created", session: makeExpertsSession("x2") }]);
    render(<CreateExpertsDialog projectId="p1" onClose={() => undefined} />);

    fireEvent.change(screen.getByLabelText("Topic"), { target: { value: "Topic" } });
    chooseOption("Preset", "Devil's advocate");
    fireEvent.click(screen.getByText("+ add expert"));
    fireEvent.click(screen.getByLabelText("Remove Security"));
    fireEvent.change(screen.getByLabelText("Expert 1 name"), { target: { value: "Chief architect" } });
    fireEvent.click(screen.getByLabelText("Move Chief architect down"));
    fireEvent.click(screen.getByText("Start"));
    await Promise.resolve();

    const create = fake.dispatch.mock.calls[0]?.[0];
    expect(create.experts.map((e: { name: string }) => e.name)).toEqual([
      "Maintainer",
      "Chief architect",
      "Devil's advocate",
    ]);
  });

  it("refuses to start without a topic", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<CreateExpertsDialog projectId="p1" onClose={() => undefined} />);
    fireEvent.click(screen.getByText("Start"));
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("offers every built-in persona as a preset", () => {
    attachFakeStore(modelWith({}));
    render(<CreateExpertsDialog projectId="p1" onClose={() => undefined} />);
    expect(optionLabels("Preset")).toEqual(EXPERT_PRESETS.map((p) => p.name));
    expect(EXPERT_PRESETS).toHaveLength(6);
  });
});
