import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { Composer } from "./Composer.tsx";
import { RailThreadRow } from "../shell/RailThreadRow.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { THREAD_DRAG_TYPE } from "../../lib/mentions.ts";
import { resetDrafts } from "../../state/drafts.ts";

const self = makeThread("t1", { worktreePath: "/wt/t1" });
const auth = makeThread("t2", { title: "Fix auth flow", updatedAt: 5 });
const other = makeThread("t3", { title: "Other project", projectId: "p2" });
const old = makeThread("t4", { title: "Archived auth", archivedAt: 9 });

function mount() {
  mockRpc({ "fs.list": () => ({ entries: [] }) });
  const fake = attachFakeStore(modelWith({ threads: { t1: self, t2: auth, t3: other, t4: old } }));
  render(<Composer thread={self} />);
  return { fake, input: screen.getByLabelText("Message") as HTMLTextAreaElement };
}

afterEach(() => {
  resetDrafts();
  cleanup();
  resetUi();
});

describe("@thread context mentions", () => {
  it("lists live threads of the same project and inserts @thread:<id>", async () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "see @auth" } });
    const list = await screen.findByRole("listbox", { name: "Mention a thread" });
    const options = Array.from(list.querySelectorAll('[role="option"]')).map((o) => o.textContent);
    expect(options).toEqual(["Fix auth flow"]);
    fireEvent.mouseDown(screen.getByRole("option", { name: /Fix auth flow/ }));
    expect(input.value).toBe("see @thread:t2 ");
    // the chip strip names the thread
    expect(screen.getByLabelText("Context threads").textContent).toContain("Fix auth flow");
  });

  it("expands the mention into a context line on send", async () => {
    const { fake, input } = mount();
    fireEvent.change(input, { target: { value: "compare with @thread:t2 and @src/a.ts" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "turn.request",
        text:
          'compare with "Fix auth flow" and `src/a.ts`\n\n' +
          'Context thread "Fix auth flow" (id t2): read it with the tide_thread_read tool before answering.',
      }),
    );
  });

  it("removes the token from the text with the chip's ✕", () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "look at @thread:t2 please" } });
    fireEvent.click(screen.getByLabelText("Remove context thread Fix auth flow"));
    expect(input.value).toBe("look at please");
    expect(screen.queryByLabelText("Context threads")).toBeNull();
  });

  it("inserts a mention when a rail thread is dropped on the composer", () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "context:" } });
    const root = input.closest("[class*='composer']") as HTMLElement;
    const drop = createEvent.drop(root, {
      dataTransfer: { files: [], items: [], types: [THREAD_DRAG_TYPE], getData: (t: string) => (t === THREAD_DRAG_TYPE ? "t2" : "") },
    });
    fireEvent(root, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(input.value).toBe("context: @thread:t2 ");
  });
});

describe("rail thread drag payload", () => {
  it("carries the thread id as text/x-tide-thread", () => {
    attachFakeStore(modelWith({ threads: { t2: auth } }));
    const { container } = render(
      <ul>
        <RailThreadRow thread={auth} siblings={[auth]} />
      </ul>,
    );
    const row = container.querySelector("[data-rail-thread='t2']") as HTMLElement;
    expect(row.getAttribute("draggable")).toBe("true");
    const data = new Map<string, string>();
    fireEvent.dragStart(row, { dataTransfer: { setData: (k: string, v: string) => data.set(k, v), effectAllowed: "" } });
    expect(data.get(THREAD_DRAG_TYPE)).toBe("t2");
  });
});
