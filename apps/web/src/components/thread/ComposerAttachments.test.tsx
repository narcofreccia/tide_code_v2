import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Composer } from "./Composer.tsx";
import { attachFakeStore, makeThread, mockRpc, modelWith, modelWithTurns, resetUi } from "../../testHarness.ts";
import { PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { resetFollowUp } from "../../lib/followUp.ts";
import { useToasts } from "../../state/toast.ts";
import { getDraft, resetDrafts } from "../../state/drafts.ts";

const REF = { name: "spec.pdf", path: ".tide/attachments/01X/spec.pdf", mediaType: "application/pdf", bytes: 3 };

function pdf(name = "spec.pdf"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: "application/pdf" });
}

function pick(files: File[]): void {
  fireEvent.change(screen.getByLabelText("Attach files"), { target: { files } });
}

afterEach(() => {
  resetDrafts();
  resetFollowUp();
  cleanup();
  resetUi();
});

describe("Composer file attachments", () => {
  it("uploads picked files on send and references them in turn.request", async () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    const rpc = mockRpc({ "attachments.upload": () => ({ attachments: [REF] }) });
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);

    pick([pdf()]);
    expect(screen.getByLabelText("Attached files").textContent).toContain("spec.pdf");
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "read this" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Send"));
    });

    await waitFor(() => expect(fake.dispatch).toHaveBeenCalled());
    const [method, params] = rpc.mock.calls[0] as [string, { threadId: string; files: { name: string; mediaType: string; data: string }[] }];
    expect(method).toBe("attachments.upload");
    expect(params.threadId).toBe("t1");
    expect(params.files[0]).toEqual({ name: "spec.pdf", mediaType: "application/pdf", data: "AQID" });
    expect(fake.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: "turn.request", text: "read this", attachments: [REF] }),
    );
    expect(screen.queryByLabelText("Attached files")).toBeNull();
  });

  it("aborts the send with a toast when the upload fails, keeping the draft", async () => {
    useToasts.setState({ toasts: [] });
    setProvidersForTest(PROVIDER_FIXTURE);
    mockRpc({
      "attachments.upload": () => {
        throw new Error("disk full");
      },
    });
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);
    pick([pdf()]);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "read this" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Send"));
    });
    await waitFor(() =>
      expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Uploading attachments failed: disk full"]),
    );
    expect(fake.dispatch).not.toHaveBeenCalled();
    expect(getDraft("t1")?.files).toHaveLength(1);
  });

  it("takes a dropped non-image file and keeps the browser from opening it", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    attachFakeStore(modelWith({}));
    const { container } = render(<Composer thread={makeThread("t1")} />);
    const root = container.firstElementChild as HTMLElement;
    const drop = createEvent.drop(root, {
      dataTransfer: { files: [pdf("notes.txt")], items: [], types: ["Files"], getData: () => "" },
    });
    fireEvent(root, drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(screen.getByLabelText("Attached files").textContent).toContain("notes.txt");
  });

  it("highlights the island while a file is held over it and clears on drop", () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    attachFakeStore(modelWith({}));
    const { container } = render(<Composer thread={makeThread("t1")} />);
    const root = container.firstElementChild as HTMLElement;
    const transfer = { files: [pdf("notes.txt")], items: [], types: ["Files"], getData: () => "" };
    fireEvent(root, createEvent.dragOver(root, { dataTransfer: transfer }));
    expect(root.hasAttribute("data-dropping")).toBe(true);
    fireEvent(root, createEvent.drop(root, { dataTransfer: transfer }));
    expect(root.hasAttribute("data-dropping")).toBe(false);
  });

  it("sends files without text with a default prompt", async () => {
    setProvidersForTest(PROVIDER_FIXTURE);
    mockRpc({ "attachments.upload": () => ({ attachments: [REF] }) });
    const fake = attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);
    pick([pdf()]);
    await act(async () => {
      fireEvent.click(screen.getByText("Send"));
    });
    await waitFor(() =>
      expect(fake.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ text: "See the attached files.", attachments: [REF] }),
      ),
    );
  });

  it("steers with attachments while the thread runs", async () => {
    const steerable = PROVIDER_FIXTURE.map((p) => (p.kind === "claude" ? { ...p, caps: { ...p.caps, steer: true } } : p));
    setProvidersForTest(steerable);
    mockRpc({ "attachments.upload": () => ({ attachments: [REF] }) });
    const running = makeThread("t1", { status: "running" });
    const fake = attachFakeStore(modelWithTurns(running, []));
    render(<Composer thread={running} />);
    pick([pdf()]);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "use this" } });
    await act(async () => {
      fireEvent.click(screen.getAllByText("Steer").at(-1)!);
    });
    await waitFor(() =>
      expect(fake.dispatch).toHaveBeenCalledWith(
        expect.objectContaining({ type: "turn.steer", text: "use this", attachments: [REF] }),
      ),
    );
  });

  it("caps the number of files with a toast", () => {
    useToasts.setState({ toasts: [] });
    setProvidersForTest(PROVIDER_FIXTURE);
    attachFakeStore(modelWith({}));
    render(<Composer thread={makeThread("t1")} />);
    pick(Array.from({ length: 11 }, (_, i) => pdf(`f${i}.pdf`)));
    expect(screen.getByLabelText("Attached files").querySelectorAll("li")).toHaveLength(10);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["At most 10 files per message"]);
  });
});
