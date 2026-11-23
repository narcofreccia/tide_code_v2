import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { resetDrafts } from "../../state/drafts.ts";
import { resetProviders, setProvidersForTest } from "../../state/providers.ts";
import { CODEX_WORK, LOGGED_OUT, PROVIDER_FIXTURE } from "../settings/fixtures.ts";

const self = makeThread("t1", { worktreePath: "/wt/t1" });

function mount() {
  mockRpc({ "fs.list": () => ({ entries: [] }), "providers.list": () => [] });
  setProvidersForTest([...PROVIDER_FIXTURE, CODEX_WORK, LOGGED_OUT]);
  const fake = attachFakeStore(modelWith({ threads: { t1: self } }));
  render(<Composer thread={self} />);
  return { fake, input: screen.getByLabelText("Message") as HTMLTextAreaElement };
}

afterEach(() => {
  resetDrafts();
  resetProviders();
  cleanup();
  resetUi();
});

describe("@delegate mentions", () => {
  it("lists ready instances except this thread's own, with their default model", async () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "@delegate:" } });
    const list = await screen.findByRole("listbox", { name: "Delegate to a harness" });
    const rows = Array.from(list.querySelectorAll('[role="option"]')).map((o) => o.textContent);
    expect(rows).toEqual(["Codex · work · gpt-5-codex"]);
  });

  it("fuzzy-matches the models after a slash and inserts the token", async () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "ask @codex:work/mini" } });
    const option = await screen.findByRole("option", { name: /gpt-5-mini/ });
    fireEvent.mouseDown(option);
    expect(input.value).toBe("ask @delegate:codex:work/gpt-5-mini ");
    expect(screen.getByLabelText("Delegate to").textContent).toContain("Codex · work (gpt-5-mini)");
  });

  it("removes the token with the chip's close button", () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "ask @delegate:codex:work/gpt-5-mini now" } });
    fireEvent.click(screen.getByLabelText("Remove delegate Codex · work (gpt-5-mini)"));
    expect(input.value).toBe("ask now");
    expect(screen.queryByLabelText("Delegate to")).toBeNull();
  });

  it("allows targeting models on this thread's own harness when a slash is typed", async () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "ask @claude/" } });
    const list = await screen.findByRole("listbox", { name: "Delegate to a harness" });
    expect(list.textContent).toContain("Claude Code");
  });

  it("sends the Delegate to: line", async () => {
    const { fake, input } = mount();
    fireEvent.change(input, { target: { value: "review this @delegate:codex:work/gpt-5-mini" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn.request",
        text:
          "review this Codex · work (gpt-5-mini)\n\n" +
          'Delegate to: use tide_delegate with provider "codex", providerId "codex:work", model "gpt-5-mini" for the part of this request addressed to it.',
      }),
    );
  });
});
