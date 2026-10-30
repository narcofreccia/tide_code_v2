import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { SlashCommandInfo } from "@tide/contracts";
import { attachFakeStore, makeThread, mockRpc, modelWith, resetUi } from "../../testHarness.ts";
import { GEMINI, PROVIDER_FIXTURE } from "../settings/fixtures.ts";
import { setProvidersForTest } from "../../state/providers.ts";
import { applySlash, filterCommands, findSlashQuery, unknownCommand } from "../../lib/slash.ts";
import { Composer } from "./Composer.tsx";

afterEach(() => {
  cleanup();
  resetUi();
});

const COMMANDS: SlashCommandInfo[] = [
  { name: "review", description: "Review the diff", argumentHint: "[path]", source: "builtin" },
  { name: "/release-notes", description: "Draft release notes", source: "custom" },
  { name: "pdf", description: "Read PDFs", source: "skill" },
];

describe("slash parsing", () => {
  it("opens only at the start of the text or of a line", () => {
    expect(findSlashQuery("/rev", 4)).toEqual({ start: 0, query: "rev" });
    expect(findSlashQuery("hi\n/re", 6)).toEqual({ start: 3, query: "re" });
    expect(findSlashQuery("see /tmp", 8)).toBeUndefined();
    expect(findSlashQuery("/review now", 11)).toBeUndefined();
  });

  it("filters by prefix and inserts `/name `", () => {
    expect(filterCommands(COMMANDS, "re").map((c) => c.name)).toEqual(["review", "/release-notes"]);
    expect(filterCommands(COMMANDS, "").length).toBe(3);
    expect(applySlash("/re tail", { start: 0, query: "re" }, 3, "review")).toEqual({ text: "/review  tail", caret: 8 });
  });

  it("flags a command the harness does not list", () => {
    expect(unknownCommand("/zzz do it", COMMANDS)).toBe("zzz");
    expect(unknownCommand("/rev", COMMANDS)).toBeUndefined();
    expect(unknownCommand("plain text", COMMANDS)).toBeUndefined();
  });
});

function mount(commands: boolean) {
  setProvidersForTest([...PROVIDER_FIXTURE, GEMINI]);
  const rpc = mockRpc({ "providers.commands": () => ({ commands: COMMANDS }) });
  const thread = commands ? makeThread("t1", { provider: "acp", providerId: "acp:gemini" }) : makeThread("t1");
  attachFakeStore(modelWith({ threads: { t1: thread } }));
  render(<Composer thread={thread} />);
  return { rpc, input: screen.getByLabelText("Message") as HTMLTextAreaElement };
}

const type = (input: HTMLTextAreaElement, value: string): void => {
  fireEvent.change(input, { target: { value, selectionStart: value.length } });
};

describe("Composer / picker", () => {
  it("lists the thread's commands with their source and inserts the pick", async () => {
    const { rpc, input } = mount(true);
    type(input, "/re");
    const review = await screen.findByRole("option", { name: /\/review/ });
    expect(review.textContent).toContain("[path]");
    expect(review.textContent).toContain("built-in");
    expect(screen.getByRole("option", { name: /release-notes/ }).textContent).toContain("custom");
    expect(screen.queryByRole("option", { name: /pdf/ })).toBeNull();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.value).toBe("/review ");
    expect(rpc).toHaveBeenCalledWith("providers.commands", { threadId: "t1" });
  });

  it("asks once per thread, not per keystroke", async () => {
    const { rpc, input } = mount(true);
    type(input, "/");
    await screen.findByRole("option", { name: /pdf/ });
    expect(screen.getByRole("option", { name: /pdf/ }).textContent).toContain("skill");
    type(input, "/p");
    type(input, "/pd");
    expect(rpc.mock.calls.filter(([method]) => method === "providers.commands")).toHaveLength(1);
  });

  it("says an unknown command goes through as text", async () => {
    const { input } = mount(true);
    type(input, "/zzz please");
    expect(await screen.findByText("Unknown command for Gemini CLI; it will be sent as text")).toBeDefined();
  });

  it("stays silent when the harness lists no commands", async () => {
    const { rpc, input } = mount(false);
    type(input, "/zzz please");
    await waitFor(() => expect(screen.queryByRole("listbox", { name: "Slash commands" })).toBeNull());
    expect(screen.queryByText(/Unknown command/)).toBeNull();
    expect(rpc).not.toHaveBeenCalled();
  });
});
