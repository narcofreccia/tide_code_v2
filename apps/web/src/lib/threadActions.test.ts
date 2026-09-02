import { afterEach, describe, expect, it } from "vitest";
import { respondApproval, updateThread } from "./threadActions.ts";
import { errorText } from "./dispatchOrToast.ts";
import { useToasts } from "../state/toast.ts";
import { attachFakeStore, modelWith, resetUi } from "../testHarness.ts";

/** What the wire hands back: a machine code plus a human message. */
class WireError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

afterEach(() => {
  resetUi();
  useToasts.setState({ toasts: [] });
});

const texts = (): string[] => useToasts.getState().toasts.map((t) => t.text);

describe("command failures reach the user", () => {
  it("toasts the server's message when a denied approval is refused", async () => {
    const fake = attachFakeStore(modelWith({}));
    fake.dispatch.mockRejectedValue(new WireError("conflict", "the turn already ended"));

    respondApproval("t1", "req-1", "decline");
    await Promise.resolve();
    await Promise.resolve();

    expect(texts()).toEqual(["Answering the approval failed: the turn already ended"]);
  });

  it("names the action that failed", async () => {
    const fake = attachFakeStore(modelWith({}));
    fake.dispatch.mockRejectedValue(new WireError("not-found", "no such thread"));

    updateThread("t1", { title: "x" });
    await Promise.resolve();
    await Promise.resolve();

    expect(texts()).toEqual(["Updating the thread failed: no such thread"]);
  });

  it("falls back to the error code when the server sent no message", () => {
    expect(errorText(new WireError("busy", ""))).toBe("busy");
    expect(errorText(new WireError("busy", "engine is busy"))).toBe("engine is busy");
  });
});
