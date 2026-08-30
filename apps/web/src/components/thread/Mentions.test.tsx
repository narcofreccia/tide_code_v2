import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { Composer } from "./Composer.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const TREE: Record<string, { name: string; path: string; kind: "file" | "dir" }[]> = {
  "": [
    { name: "src", path: "src", kind: "dir" },
    { name: "README.md", path: "README.md", kind: "file" },
  ],
  src: [{ name: "router.ts", path: "src/router.ts", kind: "file" }],
};

function mount(threadPatch = {}) {
  mockRpc({ "fs.list": ({ path }: { path?: string }) => ({ entries: TREE[path ?? ""] ?? [] }) });
  const fake = attachFakeStore(modelWith({}));
  render(<Composer thread={makeThread("t1", { worktreePath: "/wt/t1", ...threadPatch })} />);
  return fake;
}

describe("Composer @mentions", () => {
  it("opens the picker on @ and inserts the chosen path", async () => {
    mount();
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "look at @rout" } });
    const option = await screen.findByRole("option", { name: /router\.ts/ });
    fireEvent.mouseDown(option);
    expect((input as HTMLTextAreaElement).value).toBe("look at @src/router.ts ");
  });

  it("sends mentions as backticked relative paths", async () => {
    const fake = mount();
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "look at @rout" } });
    fireEvent.mouseDown(await screen.findByRole("option", { name: /router\.ts/ }));
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "turn.request",
      threadId: "t1",
      text: "look at `src/router.ts`",
    });
  });

  it("normalises a pasted absolute path inside the worktree", () => {
    mount();
    const input = screen.getByLabelText("Message");
    fireEvent.paste(input, { clipboardData: { getData: () => "/wt/t1/src/router.ts" } });
    expect((input as HTMLTextAreaElement).value).toBe("src/router.ts");
  });

  it("leaves a path outside the worktree alone", () => {
    mount();
    const input = screen.getByLabelText("Message");
    fireEvent.paste(input, { clipboardData: { getData: () => "/elsewhere/x.ts" } });
    expect((input as HTMLTextAreaElement).value).toBe("");
  });
});
