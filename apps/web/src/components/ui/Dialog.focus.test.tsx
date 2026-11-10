import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ConfirmDialog, Dialog, PromptDialog } from "./Dialog.tsx";
import { DialogFrame, PrimaryField } from "./DialogFrame.tsx";

afterEach(cleanup);

const noop = (): void => undefined;
const esc = (target: Element | null = document.activeElement): void => {
  fireEvent.keyDown(target ?? document.body, { key: "Escape" });
};

/** A button that opens a dialog, so focus has somewhere to return to. */
function Opener({ children }: { children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open ? children(() => setOpen(false)) : null}
    </>
  );
}

describe("Dialog focus", () => {
  it("is modal and labelled by its heading", () => {
    render(<ConfirmDialog title="Remove worktree?" body="Gone." onConfirm={noop} onCancel={noop} />);
    const dialog = screen.getByRole("dialog", { name: "Remove worktree?" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")?.textContent).toBe("Remove worktree?");
  });

  it("ConfirmDialog starts on the confirm button, or on Cancel when the action is destructive", () => {
    const { unmount } = render(<ConfirmDialog title="Merge?" body="" confirmLabel="Merge" onConfirm={noop} onCancel={noop} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Merge" }));
    unmount();
    render(<ConfirmDialog title="Delete?" body="" danger onConfirm={noop} onCancel={noop} />);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  });

  it("moves focus into a dialog with nothing to autofocus", () => {
    render(
      <Dialog title="Info" onCancel={noop}>
        <p>Read only</p>
      </Dialog>,
    );
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Info" }));
  });

  it("cycles Tab and Shift+Tab inside the dialog", () => {
    render(<ConfirmDialog title="Merge?" body="" confirmLabel="Merge" onConfirm={noop} onCancel={noop} />);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    const merge = screen.getByRole("button", { name: "Merge" });
    fireEvent.keyDown(merge, { key: "Tab" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(merge);
  });

  it("returns focus to the element that opened it", () => {
    render(<Opener>{(close) => <ConfirmDialog title="Merge?" body="" confirmLabel="Merge" onConfirm={close} onCancel={close} />}</Opener>);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Merge" }));
    esc();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe("Dialog Esc", () => {
  it("leaves a text field first, then cancels", () => {
    const onCancel = vi.fn();
    render(<PromptDialog title="Rename" label="Name" onSubmit={noop} onCancel={onCancel} />);
    const input = screen.getByLabelText("Name");
    expect(document.activeElement).toBe(input);
    esc(input);
    expect(onCancel).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(input);
    esc();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("closes the palette from its field at once", () => {
    const onCancel = vi.fn();
    render(
      <Dialog title="Palette" variant="palette" onCancel={onCancel}>
        <input aria-label="Search" autoFocus />
      </Dialog>,
    );
    esc(screen.getByLabelText("Search"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("closes only the topmost of two nested dialogs", () => {
    const outer = vi.fn();
    function Nested() {
      const [inner, setInner] = useState(true);
      return (
        <Dialog title="Outer" onCancel={outer}>
          <p>outer</p>
          {inner ? <ConfirmDialog title="Inner" body="" onConfirm={noop} onCancel={() => setInner(false)} /> : null}
        </Dialog>
      );
    }
    render(<Nested />);
    esc();
    expect(screen.queryByRole("dialog", { name: "Inner" })).toBeNull();
    expect(outer).not.toHaveBeenCalled();
    esc();
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it("keeps window-level Esc handlers off a key the dialog took", () => {
    const onWindow = vi.fn();
    window.addEventListener("keydown", onWindow);
    render(<ConfirmDialog title="Merge?" body="" onConfirm={noop} onCancel={noop} />);
    esc();
    window.removeEventListener("keydown", onWindow);
    expect(onWindow).not.toHaveBeenCalled();
  });
});

describe("DialogFrame inside a sheet", () => {
  it("inherits focus and the trap, and ⌘↵ still runs the primary", () => {
    const onPrimary = vi.fn();
    render(
      <Dialog title="New thread" variant="sheet" onCancel={noop}>
        <DialogFrame heading="Start a thread" primaryLabel="Start" onPrimary={onPrimary} onCancel={noop}>
          <PrimaryField label="Task" ariaLabel="Task" value="" onChange={noop} placeholder="Fix the flaky test" />
        </DialogFrame>
      </Dialog>,
    );
    const task = screen.getByLabelText("Task");
    expect(document.activeElement).toBe(task);
    fireEvent.keyDown(task, { key: "Enter", metaKey: true });
    expect(onPrimary).toHaveBeenCalledTimes(1);
    const start = screen.getByRole("button", { name: "Start" });
    start.focus();
    fireEvent.keyDown(start, { key: "Tab" });
    expect(document.activeElement).toBe(task);
  });
});
