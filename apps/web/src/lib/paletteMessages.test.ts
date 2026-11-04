import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReadModel, SearchHit } from "@tide/contracts";
import { messageHitItems, openThreadAt } from "./paletteMessages.ts";
import { forgetAllScroll, recallScroll } from "./scrollMemory.ts";
import { useUi } from "../state/ui.ts";

const hit: SearchHit = { threadId: "t1", projectId: "p1", title: "Fix login", snippet: "…the cookie bug…", field: "message", at: 5, messageId: "m9" };
const model = { projects: { p1: { id: "p1", title: "Acme" } } } as unknown as ReadModel;

beforeEach(() => {
  forgetAllScroll();
  window.localStorage.clear();
  useUi.setState({ selectedThreadId: null, view: "mission" });
});

describe("messageHitItems", () => {
  it("maps message hits to In-messages rows and skips title hits", () => {
    const items = messageHitItems(model, [hit, { threadId: "t2", projectId: "p1", title: "T", snippet: "T", field: "title", at: 1 }]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ group: "In messages", label: "…the cookie bug…", detail: "Fix login · Acme" });
  });

  it("run remembers the row and selects the thread", () => {
    messageHitItems(model, [hit])[0]!.run();
    expect(recallScroll("t1")).toMatchObject({ rowKey: "m9", atEnd: false });
    expect(useUi.getState().selectedThreadId).toBe("t1");
  });
});

describe("openThreadAt", () => {
  it("dispatches tide:scroll-to when the thread is already open", () => {
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    const seen = vi.fn();
    window.addEventListener("tide:scroll-to", seen);
    openThreadAt("t1", "m9");
    window.removeEventListener("tide:scroll-to", seen);
    expect(seen).toHaveBeenCalledOnce();
    expect(recallScroll("t1")).toBeUndefined();
  });
});
