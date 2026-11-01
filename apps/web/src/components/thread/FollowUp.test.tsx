import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { Message, Turn } from "@tide/contracts";
import { Composer } from "./Composer.tsx";
import { STEER_FALLBACK_NOTE } from "./steerFallback.ts";
import { attachFakeStore, makeMessage, makeThread, makeTurn, modelWithTurns, resetUi } from "../../testHarness.ts";
import { PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { resetFollowUp } from "../../lib/followUp.ts";
import { useServerSettings } from "../../state/serverSettings.ts";
import { setProvidersForTest } from "../../state/providers.ts";

const STEERABLE = PROVIDER_FIXTURE.map((p) => (p.kind === "claude" ? { ...p, caps: { ...p.caps, steer: true } } : p));
const running = makeThread("t1", { status: "running" });

beforeEach(() => resetFollowUp());
afterEach(() => {
  cleanup();
  resetUi();
  resetFollowUp();
});

function type(text: string): HTMLElement {
  const input = screen.getByLabelText("Message");
  fireEvent.change(input, { target: { value: text } });
  return input;
}

describe("Composer follow-up mode", () => {
  it("defaults to steer when the harness can steer", async () => {
    setProvidersForTest(STEERABLE);
    const fake = attachFakeStore(modelWithTurns(running, []));
    render(<Composer thread={running} />);
    type("also this");
    await act(async () => {
      fireEvent.click(screen.getAllByText("Steer").at(-1)!);
    });
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.steer", threadId: "t1", text: "also this", commandId: expect.any(String) }),
    );
  });

  it("⌘↵ always sends in the selected mode", async () => {
    setProvidersForTest(STEERABLE);
    const fake = attachFakeStore(modelWithTurns(running, []));
    render(<Composer thread={running} />);
    const input = type("now");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.steer", text: "now" }));
  });

  it("⌥↵ sends with the alternate mode", async () => {
    setProvidersForTest(STEERABLE);
    const fake = attachFakeStore(modelWithTurns(running, []));
    render(<Composer thread={running} />);
    const input = type("later");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", altKey: true });
    });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.request", text: "later" }));
  });

  it("hints both send keys, inverted when the mode is queue", () => {
    setProvidersForTest(STEERABLE);
    attachFakeStore(modelWithTurns(running, []));
    render(<Composer thread={running} />);
    const hint = () => screen.getByText("⌥↵").parentElement?.textContent ?? "";
    expect(hint()).toContain("↵ steer · ⌥↵ queue");
    fireEvent.click(screen.getByRole("button", { name: "Queue", pressed: false }));
    expect(hint()).toContain("↵ queue · ⌥↵ steer");
  });

  it("takes the default from server settings", async () => {
    useServerSettings.setState((s) => ({ settings: { ...s.settings, followUpMode: "queue" } }));
    setProvidersForTest(STEERABLE);
    const fake = attachFakeStore(modelWithTurns(running, []));
    render(<Composer thread={running} />);
    const input = type("after");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.request", text: "after" }));
  });

  it("keeps the toggle per thread in memory, not in localStorage", () => {
    setProvidersForTest(STEERABLE);
    attachFakeStore(modelWithTurns(running, []));
    const { unmount } = render(<Composer thread={running} />);
    fireEvent.click(screen.getByRole("button", { name: "Queue", pressed: false }));
    expect(screen.getAllByText("Queue").length).toBeGreaterThan(1);
    expect(JSON.stringify({ ...window.localStorage })).not.toMatch(/queue/i);
    unmount();
    const other = makeThread("t2", { status: "running" });
    render(<Composer thread={other} />);
    expect(screen.getByRole("button", { name: "Steer", pressed: true })).toBeDefined();
  });

  it("disables the toggle with a tooltip when the harness cannot steer", async () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    const fake = attachFakeStore(modelWithTurns(running, []));
    render(<Composer thread={running} />);
    const steer = screen.getByRole("button", { name: "Steer" }) as HTMLButtonElement;
    expect(steer.disabled).toBe(true);
    expect(steer.title).toBe("claude cannot steer; follow-ups queue");
    type("x");
    await act(async () => {
      fireEvent.click(screen.getAllByText("Queue").at(-1)!);
    });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.request" }));
  });

  it("hints at the lossy handoff after a provider switch", () => {
    const thread = makeThread("t1", { provider: "codex" });
    attachFakeStore(modelWithTurns(thread, [makeTurn("u1", { provider: "claude" })], [makeMessage("m1")]));
    render(<Composer thread={thread} />);
    expect(screen.getByText("History will be handed over to Codex as text (lossy: no tool state)")).toBeDefined();
  });
});

describe("queue list", () => {
  const queued = (id: string, text: string) => [
    makeTurn(id, { status: "queued" }),
    makeMessage(`m-${id}`, { turnId: id, text }),
  ];
  function setup() {
    const [t1, m1] = queued("q1", "first");
    const [t2, m2] = queued("q2", "second");
    const model = modelWithTurns(running, [t1!, t2!] as never[], [m1!, m2!] as never[]);
    return attachFakeStore(model);
  }

  it("reorders with the full new order", () => {
    const fake = setup();
    setProvidersForTest(STEERABLE);
    render(<Composer thread={running} />);
    const list = screen.getByRole("list", { name: "Queued messages" });
    expect(list.textContent).toContain("first");
    fireEvent.click(screen.getAllByLabelText("Move queued turn down")[0]!);
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.reorder", threadId: "t1", turnIds: ["q2", "q1"] }),
    );
  });

  it("edits a queued turn inline", async () => {
    const fake = setup();
    render(<Composer thread={running} />);
    fireEvent.click(screen.getAllByLabelText("Edit queued turn")[0]!);
    fireEvent.change(screen.getByLabelText("Edit queued message"), { target: { value: "first, revised" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.edit", turnId: "q1", text: "first, revised" }),
    );
  });

  it("promotes only when the thread runs and the harness steers", () => {
    const fake = setup();
    setProvidersForTest(PROVIDER_FIXTURE);
    const { unmount } = render(<Composer thread={running} />);
    expect(screen.queryAllByText("Send now as steer")).toHaveLength(0);
    unmount();
    setProvidersForTest(STEERABLE);
    render(<Composer thread={running} />);
    fireEvent.click(screen.getAllByText("Send now as steer")[0]!);
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.promote", turnId: "q1" }));
  });

  it("says when a queued message is a steer the harness refused, with the reason as a tooltip", () => {
    const reason = "the harness refused the message: no turn is running on this claude session";
    const fellBack = { ...makeTurn("q1", { status: "queued" }), steerFallback: { reason } } as Turn;
    const [t2, m2] = queued("q2", "second");
    attachFakeStore(modelWithTurns(running, [fellBack, t2!] as Turn[], [makeMessage("m-q1", { turnId: "q1", text: "first" }), m2!] as Message[]));
    render(<Composer thread={running} />);
    const notes = screen.getAllByText(STEER_FALLBACK_NOTE);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.getAttribute("title")).toBe(reason);
    expect(notes[0]!.closest("li")?.textContent).toContain("first");
  });

  it("drops a queued turn with ×", () => {
    const fake = setup();
    render(<Composer thread={running} />);
    fireEvent.click(screen.getAllByLabelText("Remove queued turn")[0]!);
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "turn.dequeue", turnId: "q1" });
  });
});
