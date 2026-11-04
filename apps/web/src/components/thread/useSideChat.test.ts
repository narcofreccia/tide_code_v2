import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientCommand, Message, ReadModel, Thread } from "@tide/contracts";
import { COMPOSE_EVENT } from "../../lib/cite.ts";
import { getDraft, setDraft } from "../../state/drafts.ts";
import { useToasts } from "../../state/toast.ts";
import { useUi } from "../../state/ui.ts";
import { activeTab, openSideTab, threadTabs } from "../../state/workbench.ts";
import { attachFakeStore, makeMessage, makeThread, makeTurn, modelWith, resetUi, type FakeStore } from "../../testHarness.ts";
import { bringBack, bringBackBlocked, closeSideChat, createdSideId, openSideChat, startSideChat } from "./useSideChat.ts";

afterEach(() => {
  resetUi();
});

const parent = makeThread("t1", { title: "Parent" });
const side = makeThread("s1", { title: "Side: Parent", role: "side", parentThreadId: "t1" });

/** A fake server: `thread.side` creates `s1`, anything else lands with no events. */
function serve(model: ReadModel): FakeStore {
  const fake = attachFakeStore(model);
  fake.dispatch.mockImplementation(async (command: ClientCommand) =>
    command.type === "thread.side" ? { seq: 1, events: [{ seq: 1, ts: 1, event: { type: "thread.created", thread: side } }] } : { seq: 0, events: [] },
  );
  return fake;
}

const commands = (fake: FakeStore): string[] => fake.dispatch.mock.calls.map(([c]) => (c as ClientCommand).type);

function withAnswer(text: string, sidePatch: Partial<Thread> = {}): ReadModel {
  const m = modelWith({ threads: { t1: parent, s1: { ...side, ...sidePatch } } });
  m.turns["u9"] = makeTurn("u9", { threadId: "s1", status: "completed" });
  const messages: Message[] = [makeMessage("m1", { threadId: "s1", turnId: "u9", role: "user", text: "q" }), makeMessage("m2", { threadId: "s1", turnId: "u9", role: "assistant", text })];
  for (const msg of messages) m.messages[msg.id] = msg;
  m.threadMessages["s1"] = messages.map((msg) => msg.id);
  return m;
}

describe("openSideChat", () => {
  it("asks for the side chat, then sends the prompt to it and opens its tab", async () => {
    const fake = serve(modelWith({ threads: { t1: parent } }));
    useUi.setState({ focusMode: "thread" });
    await expect(openSideChat("t1", "what is X?")).resolves.toBe("s1");
    expect(commands(fake)).toEqual(["thread.side", "turn.request"]);
    expect(fake.dispatch.mock.calls[0]?.[0]).toMatchObject({ type: "thread.side", threadId: "t1" });
    expect(fake.dispatch.mock.calls[1]?.[0]).toMatchObject({ type: "turn.request", threadId: "s1", text: "what is X?" });
    expect(activeTab("t1")).toEqual({ kind: "side", threadId: "s1" });
    expect(useUi.getState().focusMode).toBe("split");
  });

  it("an empty prompt opens the side chat without a turn; attachments get a toast", async () => {
    const fake = serve(modelWith({ threads: { t1: parent } }));
    await openSideChat("t1", "", { hadAttachments: true });
    expect(commands(fake)).toEqual(["thread.side"]);
    expect(useToasts.getState().toasts.map((t) => t.text)).toContain("Side chats take text only");
  });

  it("a refusal is a toast, not a tab", async () => {
    const fake = attachFakeStore(modelWith({ threads: { t1: parent } }));
    fake.dispatch.mockRejectedValue(new Error("side chats do not nest"));
    await expect(openSideChat("t1", "x")).resolves.toBeUndefined();
    expect(threadTabs("t1").some((t) => t.kind === "side")).toBe(false);
    expect(useToasts.getState().toasts[0]?.text).toMatch(/Side chat failed/);
  });

  it("finds the created thread in the receipt", () => {
    expect(createdSideId({ seq: 0, events: [] })).toBeUndefined();
  });
});

describe("closeSideChat", () => {
  it("deletes a side chat that never had a turn", () => {
    const fake = attachFakeStore(modelWith({ threads: { t1: parent, s1: side } }));
    openSideTab("t1", "s1");
    closeSideChat("t1", "s1");
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "thread.delete", threadId: "s1" });
    expect(threadTabs("t1").some((t) => t.kind === "side")).toBe(false);
  });

  it("only closes the tab of a used one", () => {
    const fake = attachFakeStore(withAnswer("done"));
    openSideTab("t1", "s1");
    closeSideChat("t1", "s1");
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(threadTabs("t1").some((t) => t.kind === "side")).toBe(false);
  });
});

describe("bringBack", () => {
  it("quotes the last answer into the parent's composer only", () => {
    attachFakeStore(withAnswer("Use the cache."));
    const seen = vi.fn();
    const listener = (e: Event): void => seen((e as CustomEvent<unknown>).detail);
    window.addEventListener(COMPOSE_EVENT, listener);
    bringBack("s1", "t1");
    window.removeEventListener(COMPOSE_EVENT, listener);
    expect(seen).toHaveBeenCalledWith({ text: "> Use the cache.\n— from side chat “Side: Parent”\n\n", mode: "append", threadId: "t1" });
  });

  it("is off while the side chat runs or has no answer", () => {
    const running = withAnswer("x", { status: "running" });
    expect(bringBackBlocked(running, "s1")).toMatch(/still answering/);
    expect(bringBackBlocked(modelWith({ threads: { s1: side } }), "s1")).toBe("no answer yet");
    attachFakeStore(running);
    const seen = vi.fn();
    window.addEventListener(COMPOSE_EVENT, seen);
    bringBack("s1", "t1");
    window.removeEventListener(COMPOSE_EVENT, seen);
    expect(seen).not.toHaveBeenCalled();
  });

  it("writes the parent's draft directly in Code focus, where its composer is not mounted", () => {
    attachFakeStore(withAnswer("ok"));
    useUi.setState({ focusMode: "workbench" });
    setDraft("t1", { text: "mine" });
    bringBack("s1", "t1");
    expect(getDraft("t1")?.text).toBe("mine\n\n> ok\n— from side chat “Side: Parent”\n\n");
    expect(useUi.getState().focusMode).toBe("split");
  });
});

describe("startSideChat", () => {
  it("puts /side in front of the draft", () => {
    useUi.setState({ focusMode: "workbench" });
    setDraft("t1", { text: "why is it slow?" });
    startSideChat("t1");
    expect(getDraft("t1")?.text).toBe("/side why is it slow?");
  });
});
