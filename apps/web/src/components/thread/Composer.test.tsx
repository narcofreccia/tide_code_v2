import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer.tsx";
import { attachFakeStore, makeThread, modelWith, resetUi } from "../../testHarness.ts";
import { PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { useToasts } from "../../state/toast.ts";
import { useUi } from "../../state/ui.ts";

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
      fireEvent.click(screen.getByText("Queue"));
    });

    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.request", threadId: "t1", text: "and then this" }),
    );
    expect(screen.getByText("queued")).toBeDefined();
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
