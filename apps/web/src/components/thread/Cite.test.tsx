import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer.tsx";
import { MessageItem } from "./MessageItem.tsx";
import { CiteButton } from "./CiteButton.tsx";
import { attachFakeStore, makeMessage, makeThread, modelWithTurns, resetUi } from "../../testHarness.ts";
import { COMPOSE_EVENT } from "../../lib/cite.ts";
import { resetDrafts } from "../../state/drafts.ts";

afterEach(() => {
  resetDrafts();
  cleanup();
  resetUi();
});

function mountComposer(initial = "") {
  const thread = makeThread("t1");
  attachFakeStore(modelWithTurns(thread, []));
  render(<Composer thread={thread} />);
  const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
  if (initial !== "") fireEvent.change(input, { target: { value: initial } });
  return input;
}

describe("compose event modes", () => {
  it("keeps the legacy string form (replace)", () => {
    const input = mountComposer("old");
    act(() => {
      window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: "new" }));
    });
    expect(input.value).toBe("new");
  });

  it("appends after a blank line in append mode", () => {
    const input = mountComposer("my question");
    act(() => {
      window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: { text: "> quoted\n\n", mode: "append" } }));
    });
    expect(input.value).toBe("my question\n\n> quoted\n\n");
  });
});

describe("Quote and Cite", () => {
  it("Quote on an assistant reply appends a blockquote with its turn label", async () => {
    const input = mountComposer("draft");
    const message = makeMessage("m1", { role: "assistant", text: "Use a mutex here.\nThen retry." });
    render(
      <ul>
        <MessageItem message={message} citeLabel='turn 2 of "Fix auth"' />
      </ul>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Quote" }));
    expect(input.value).toBe('draft\n\n> Use a mutex here.\n> Then retry.\n— from turn 2 of "Fix auth"\n\n');
    await waitFor(() => expect(document.activeElement).toBe(input));
  });

  it("shows Cite over a selection inside a reply and appends it", () => {
    const input = mountComposer();
    const root = { current: null as HTMLElement | null };
    const message = makeMessage("m1", { role: "assistant", text: "The cache is stale after a deploy." });
    const { container } = render(
      <div ref={(el) => void (root.current = el)}>
        <ul>
          <MessageItem message={message} citeLabel="turn 1" />
        </ul>
        <CiteButton root={root} />
      </div>,
    );
    const paragraph = container.querySelector("[data-cite-label] p") as HTMLElement;
    const text = paragraph.firstChild as Text;
    const range = document.createRange();
    range.setStart(text, 4);
    range.setEnd(text, 9);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(paragraph);
    fireEvent.click(screen.getByRole("button", { name: "Cite" }));
    expect(input.value).toBe("> cache\n— from turn 1\n\n");
    expect(screen.queryByRole("button", { name: "Cite" })).toBeNull();
  });

  it("does not offer Cite for a selection outside replies", () => {
    mountComposer();
    const root = { current: null as HTMLElement | null };
    const { container } = render(
      <div ref={(el) => void (root.current = el)}>
        <p>plain text here</p>
        <CiteButton root={root} />
      </div>,
    );
    const p = container.querySelector("p") as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
    fireEvent.mouseUp(p);
    expect(screen.queryByRole("button", { name: "Cite" })).toBeNull();
  });
});
