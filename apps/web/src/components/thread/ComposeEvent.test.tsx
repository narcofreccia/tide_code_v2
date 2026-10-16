import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { Composer } from "./Composer.tsx";
import { COMPOSE_EVENT } from "./EmptyThread.tsx";
import { attachFakeStore, makeThread, modelWithTurns, resetUi } from "../../testHarness.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

describe("Composer compose event", () => {
  it("fills the composer from tide:compose without sending", () => {
    const thread = makeThread("t1");
    const fake = attachFakeStore(modelWithTurns(thread, []));
    render(<Composer thread={thread} />);
    act(() => {
      window.dispatchEvent(new CustomEvent<string>(COMPOSE_EVENT, { detail: "Explain the repo" }));
    });
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Explain the repo");
    expect(fake.dispatch).not.toHaveBeenCalled();
  });
});
