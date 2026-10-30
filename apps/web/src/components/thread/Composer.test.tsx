import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { useToasts } from "../../state/toast.ts";
import { useUi } from "../../state/ui.ts";
import { getDraft, resetDrafts, setDraft, useDrafts } from "../../state/drafts.ts";

/** A one-pixel PNG as a real `File`, so jsdom's FileReader does the base64. */
function pngFile(name = "shot.png", type = "image/png"): File {
  return new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], name, { type });
}

function pasteFiles(files: File[]): void {
  fireEvent.paste(screen.getByLabelText("Message"), {
    clipboardData: { files, items: [], getData: () => "" },
  });
}

afterEach(() => {
  resetDrafts();
  cleanup();
  resetUi();
});

describe("Composer", () => {
  it("sends a turn with ⌘↵", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(fake.dispatch).toHaveBeenCalledWith({
      type: "turn.request",
      threadId: "t1",
      text: "go",
      requestId: expect.stringMatching(/^[0-9A-Z]{26}$/),
    });
  });

  it("becomes Stop while the thread runs and interrupts the turn", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    expect(screen.queryByText("Send")).toBeNull();
    fireEvent.click(screen.getByText("Stop"));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "turn.interrupt", threadId: "t1" });
  });

  it("shows one Stop with Esc inside it and a single steer/queue hint while running", () => {
    attachFakeStore(modelWith({}));
    setProvidersForTest(PROVIDER_FIXTURE);
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    const stops = screen.getAllByRole("button", { name: /Stop/ });
    expect(stops).toHaveLength(1);
    expect(stops[0]?.querySelector("kbd")?.textContent).toBe("Esc");
    expect(screen.queryByText("stop")).toBeNull();
    expect(screen.getByRole("group", { name: "Follow-up mode" })).toBeDefined();
    // the settings pills sit on their own row, apart from the send controls
    const pills = screen.getByRole("combobox", { name: "Model" });
    expect(pills.closest("[class*='settings']")).not.toBeNull();
    expect(stops[0]?.closest("[class*='settings']")).toBeNull();
  });

  it("hides Stop and the follow-up toggle when idle", () => {
    attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);
    expect(screen.queryByRole("button", { name: /Stop/ })).toBeNull();
    expect(screen.queryByRole("group", { name: "Follow-up mode" })).toBeNull();
    expect(screen.getByText("send in background")).toBeDefined();
  });

  it("interrupts on Esc while running", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    screen.getByLabelText("Message").focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "turn.interrupt", threadId: "t1" });
  });

  it("leaves Esc to the overlay that owns it", () => {
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    screen.getByLabelText("Message").focus();
    useUi.getState().setPaletteOpen(true);

    fireEvent.keyDown(window, { key: "Escape" });

    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("ignores Esc pressed outside the thread column", () => {
    const fake = attachFakeStore(modelWith({}));
    const outside = document.createElement("button");
    document.body.append(outside);
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    outside.focus();

    fireEvent.keyDown(window, { key: "Escape" });

    expect(fake.dispatch).not.toHaveBeenCalled();
    outside.remove();
  });

  it("disables the pills while running", () => {
    attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    expect(screen.getByLabelText<HTMLSelectElement>("Provider").disabled).toBe(true);
  });

  it("queues a turn sent while the thread runs, keeping Stop available", async () => {
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    const input = screen.getByLabelText("Message");

    fireEvent.change(input, { target: { value: "and then this" } });
    await act(async () => {
      fireEvent.click(screen.getAllByText("Queue").at(-1)!);
    });

    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.request", threadId: "t1", text: "and then this" }),
    );
    expect(screen.getByText("Stop")).toBeDefined();
  });

  it("attaches a pasted image and sends it with the turn", async () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);

    pasteFiles([pngFile()]);
    await waitFor(() => expect(screen.getByLabelText("Attached images")).toBeDefined());

    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "what is this" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Send"));
    });

    const command = fake.dispatch.mock.calls[0]?.[0] as { images?: { mediaType: string; data: string }[] };
    expect(command.images).toHaveLength(1);
    expect(command.images?.[0]?.mediaType).toBe("image/png");
    expect(command.images?.[0]?.data.length).toBeGreaterThan(0);
  });

  it("removes a pending attachment", async () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);

    pasteFiles([pngFile()]);
    await waitFor(() => expect(screen.getByLabelText("Attached images")).toBeDefined());
    fireEvent.click(screen.getByLabelText("Remove attachment img-1"));

    expect(screen.queryByLabelText("Attached images")).toBeNull();
  });

  it("refuses images when the harness does not take them", async () => {
    useToasts.setState({ toasts: [] });
    setProvidersForTest(PROVIDER_FIXTURE);
    attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1", { provider: "codex" })} />);

    pasteFiles([pngFile()]);

    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["This harness does not accept images"]),
    );
    expect(screen.queryByLabelText("Attached images")).toBeNull();
  });

  it("grows the textarea up to eight rows", () => {
    attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);
    const input = screen.getByLabelText<HTMLTextAreaElement>("Message");
    expect(input.rows).toBe(3);
    fireEvent.change(input, { target: { value: "a\n".repeat(20) } });
    expect(input.rows).toBe(8);
  });
});

describe("Composer idempotent send", () => {
  it("retries a failed send with the same requestId, and a new draft gets a new one", async () => {
    const fake = attachFakeStore(modelWith({}));
    fake.dispatch.mockRejectedValueOnce(new Error("socket closed"));
    render(<Composer thread={makeThread("t1")} />);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "go" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    const ids = fake.dispatch.mock.calls.map((c) => (c[0] as { requestId: string }).requestId);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);

    fireEvent.change(input, { target: { value: "next" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    const third = (fake.dispatch.mock.calls[2]?.[0] as { requestId: string }).requestId;
    expect(third).not.toBe(ids[0]);
  });

  it("treats a refused retry whose turn already landed as sent", async () => {
    const model = modelWith({});
    const fake = attachFakeStore(model);
    fake.dispatch.mockImplementationOnce(async (command: unknown) => {
      const { requestId } = command as { requestId: string };
      model.turns.u1 = { id: "u1", threadId: "t1", status: "running", requestedAt: 1, requestId };
      throw new Error("conflict");
    });
    render(<Composer thread={makeThread("t1")} />);
    const input = screen.getByLabelText("Message") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "go" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    });
    expect(input.value).toBe("");
  });
});

describe("Composer drafts", () => {
  it("restores the draft after a remount and shows the Draft hint", () => {
    attachFakeStore(modelWith({}));
    const first = render(<Composer thread={makeThread("t1")} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "half" } });
    first.unmount();
    render(<Composer thread={makeThread("t1")} />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("half");
    expect(screen.getByText("Draft")).toBeDefined();
  });

  it("keeps a separate draft per thread", () => {
    attachFakeStore(modelWith({}));
    const view = render(<Composer thread={makeThread("t1")} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "one" } });
    view.rerender(<Composer thread={makeThread("t2")} />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    view.rerender(<Composer thread={makeThread("t1")} />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("one");
  });

  it("stashes then applies into another thread", () => {
    attachFakeStore(modelWith({}));
    const view = render(<Composer thread={makeThread("t1")} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "later" } });
    fireEvent.click(screen.getByRole("button", { name: /Stash/ }));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("");
    view.rerender(<Composer thread={makeThread("t2")} />);
    fireEvent.click(screen.getByRole("button", { name: /Apply stash/ }));
    fireEvent.click(screen.getByText("later"));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("later");
    expect(useDrafts.getState().stash).toHaveLength(0);
  });

  it("⌘↵ while idle sends, clears the draft and returns to Mission Control", async () => {
    const fake = attachFakeStore(modelWith({}));
    useUi.getState().selectThread("t1");
    render(<Composer thread={makeThread("t1")} />);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "go" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(fake.dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: "turn.request", text: "go" }));
    await waitFor(() => expect(useUi.getState().view).toBe("mission"));
    expect(getDraft("t1")).toBeUndefined();
  });

  it("plain Enter-less send keeps the thread open and clears the draft", async () => {
    attachFakeStore(modelWith({}));
    useUi.getState().selectThread("t1");
    render(<Composer thread={makeThread("t1")} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "go" } });
    fireEvent.click(screen.getByText("Send"));
    await waitFor(() => expect(getDraft("t1")).toBeUndefined());
    expect(useUi.getState().view).toBe("thread");
  });

  it("⌘↵ while running keeps the follow-up behaviour and stays put", async () => {
    const fake = attachFakeStore(modelWith({}));
    useUi.getState().selectThread("t1");
    render(<Composer thread={makeThread("t1", { status: "running" })} />);
    const input = screen.getByLabelText("Message");
    fireEvent.change(input, { target: { value: "more" } });
    fireEvent.keyDown(input, { key: "Enter", metaKey: true });
    expect(fake.dispatch).toHaveBeenCalled();
    await waitFor(() => expect(getDraft("t1")).toBeUndefined());
    expect(useUi.getState().view).toBe("thread");
  });

  it("seeds from a pre-existing store draft", () => {
    attachFakeStore(modelWith({}));
    setDraft("t1", { text: "from store" });
    render(<Composer thread={makeThread("t1")} />);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("from store");
  });
});
