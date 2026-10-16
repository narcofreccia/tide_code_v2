import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { useDocumentTitle } from "./useDocumentTitle.ts";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../testHarness.ts";
import { useUi } from "../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

function Probe() {
  useDocumentTitle();
  return null;
}

describe("useDocumentTitle", () => {
  it("names the open thread, else the view", () => {
    attachFakeStore(modelWith({ threads: { t1: makeThread("t1", { title: "Router" }) } }));
    useUi.setState({ selectedThreadId: "t1", view: "thread" });
    render(<Probe />);
    expect(document.title).toBe("Router · Tide");
    act(() => useUi.setState({ view: "mission" }));
    expect(document.title).toBe("Mission Control · Tide");
    act(() => useUi.setState({ view: "settings" }));
    expect(document.title).toBe("Settings · Tide");
  });
});
