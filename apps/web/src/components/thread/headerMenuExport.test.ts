import { afterEach, describe, expect, it, vi } from "vitest";
import { headerMenu } from "./headerMenu.ts";
import { buildPaletteItems } from "../../lib/paletteItems.ts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";

const exportThreadMarkdown = vi.fn();
const copyThreadMarkdown = vi.fn();
vi.mock("../../lib/threadExport.ts", () => ({
  exportThreadMarkdown: (id: string) => exportThreadMarkdown(id),
  copyThreadMarkdown: (id: string) => copyThreadMarkdown(id),
}));

afterEach(() => {
  resetUi();
  exportThreadMarkdown.mockClear();
  copyThreadMarkdown.mockClear();
});

describe("thread export actions", () => {
  it("the ⋯ menu exports and copies the thread as Markdown", () => {
    const thread = makeThread("t1");
    const fake = attachFakeStore(modelWith({ threads: { t1: thread } }));
    const items = headerMenu(fake.store.getState().model, thread);
    items.find((i) => i.label === "Export as Markdown")?.onSelect?.();
    expect(exportThreadMarkdown).toHaveBeenCalledWith("t1");
    items.find((i) => i.label === "Copy as Markdown")?.onSelect?.();
    expect(copyThreadMarkdown).toHaveBeenCalledWith("t1");
  });

  it("the palette offers both for the open thread", () => {
    const thread = makeThread("t1");
    const model = modelWith({ threads: { t1: thread } });
    const items = buildPaletteItems({ model, selectedThreadId: "t1" });
    items.find((i) => i.id === "thread:export-md")?.run();
    items.find((i) => i.id === "thread:copy-md")?.run();
    expect(exportThreadMarkdown).toHaveBeenCalledWith("t1");
    expect(copyThreadMarkdown).toHaveBeenCalledWith("t1");
    expect(buildPaletteItems({ model, selectedThreadId: null }).some((i) => i.id === "thread:export-md")).toBe(false);
  });
});
