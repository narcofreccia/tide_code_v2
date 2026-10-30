import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectDialogHost } from "./ProjectDialogs.tsx";
import { attachFakeStore, modelWith, resetUi } from "../../testHarness.ts";
import { setRpcCaller } from "../../state/model.ts";
import { useUi } from "../../state/ui.ts";

afterEach(() => {
  cleanup();
  resetUi();
});

const project = { id: "p1", title: "Tide", rootPath: "/src/tide", createdAt: 1, updatedAt: 1 };

function open() {
  const fake = attachFakeStore(modelWith({ projects: { p1: project } }));
  useUi.getState().setProjectDialog({ kind: "icon", projectId: "p1" });
  render(<ProjectDialogHost />);
  return fake;
}

describe("Project icon dialog", () => {
  it("detects from the repo, then updates the project", async () => {
    const fake = open();
    setRpcCaller((async (method: string) => {
      expect(method).toBe("project.detectIcon");
      return { icon: { kind: "data", value: "data:image/png;base64,AAAA" }, source: "favicon.png" };
    }) as never);
    fireEvent.click(screen.getByRole("button", { name: "Detect from repo" }));
    await waitFor(() =>
      expect(fake.dispatch).toHaveBeenCalledWith({
        type: "project.update",
        projectId: "p1",
        icon: { kind: "data", value: "data:image/png;base64,AAAA" },
      }),
    );
  });

  it("says so when nothing is found", async () => {
    const fake = open();
    setRpcCaller((async () => ({})) as never);
    fireEvent.click(screen.getByRole("button", { name: "Detect from repo" }));
    await screen.findByText(/No favicon found/);
    expect(fake.dispatch).not.toHaveBeenCalled();
  });

  it("takes the first grapheme of the typed emoji", () => {
    const fake = open();
    fireEvent.change(screen.getByLabelText("Emoji"), { target: { value: "🚀x" } });
    fireEvent.click(screen.getByRole("button", { name: "Use emoji" }));
    expect(fake.dispatch).toHaveBeenCalledWith({ type: "project.update", projectId: "p1", icon: { kind: "emoji", value: "🚀" } });
  });
});
