import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConfirmDialog, Dialog } from "./Dialog.tsx";

afterEach(cleanup);

const noop = (): void => undefined;

describe("Dialog size", () => {
  it("defaults to sm so existing dialogs keep their width", () => {
    render(<ConfirmDialog title="Delete?" body="Gone for good." onConfirm={noop} onCancel={noop} />);
    expect(screen.getByRole("dialog", { name: "Delete?" }).getAttribute("data-size")).toBe("sm");
  });

  it("takes md and lg", () => {
    render(
      <>
        <Dialog title="Medium" size="md" onCancel={noop}>
          body
        </Dialog>
        <Dialog title="Large" size="lg" onCancel={noop}>
          body
        </Dialog>
      </>,
    );
    expect(screen.getByRole("dialog", { name: "Medium" }).getAttribute("data-size")).toBe("md");
    expect(screen.getByRole("dialog", { name: "Large" }).getAttribute("data-size")).toBe("lg");
  });

  it("leaves the palette and sheet variants unsized", () => {
    render(
      <Dialog title="Palette" variant="palette" size="lg" onCancel={noop}>
        body
      </Dialog>,
    );
    expect(screen.getByRole("dialog", { name: "Palette" }).hasAttribute("data-size")).toBe(false);
  });
});
