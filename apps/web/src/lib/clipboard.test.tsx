import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { COPY_UNAVAILABLE, copyToClipboard, copyWithToast, useManualCopy } from "./clipboard.ts";
import { useToasts } from "../state/toast.ts";
import { ToastHost } from "../components/ui/Toast.tsx";

const original = Object.getOwnPropertyDescriptor(window.navigator, "clipboard");

function setClipboard(value: unknown): void {
  Object.defineProperty(window.navigator, "clipboard", { value, configurable: true });
}

function setExecCommand(impl: ((command: string) => boolean) | undefined): ReturnType<typeof vi.fn> {
  const fn = vi.fn(impl ?? (() => false));
  Object.defineProperty(document, "execCommand", { value: impl === undefined ? undefined : fn, configurable: true, writable: true });
  return fn;
}

afterEach(() => {
  cleanup();
  if (original) Object.defineProperty(window.navigator, "clipboard", original);
  else delete (window.navigator as unknown as Record<string, unknown>)["clipboard"];
  delete (document as unknown as Record<string, unknown>)["execCommand"];
  useToasts.setState({ toasts: [] });
  useManualCopy.setState({ text: undefined });
});

describe("copyToClipboard", () => {
  it("uses the Clipboard API when the page has it", async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard({ writeText });
    const exec = setExecCommand(() => true);
    expect(await copyToClipboard("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
    expect(exec).not.toHaveBeenCalled();
  });

  it("falls back to a hidden textarea + execCommand without it (plain-http LAN), and gives focus back", async () => {
    setClipboard(undefined);
    let copied = "";
    const exec = setExecCommand((command) => {
      copied = (document.activeElement as HTMLTextAreaElement).value;
      return command === "copy";
    });
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(await copyToClipboard("over http")).toBe(true);
    expect(exec).toHaveBeenCalledWith("copy");
    expect(copied).toBe("over http");
    expect(document.querySelector("textarea")).toBeNull();
    expect(document.activeElement).toBe(input);
    input.remove();
  });

  it("falls back when the Clipboard API rejects", async () => {
    setClipboard({ writeText: vi.fn(async () => Promise.reject(new Error("denied"))) });
    setExecCommand(() => true);
    expect(await copyToClipboard("x")).toBe(true);
  });

  it("is false when both fail", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);
    expect(await copyToClipboard("x")).toBe(false);
    setExecCommand(undefined);
    expect(await copyToClipboard("x")).toBe(false);
  });
});

describe("copyWithToast", () => {
  it("confirms a real copy with the caller's wording", async () => {
    setClipboard({ writeText: vi.fn(async () => undefined) });
    expect(await copyWithToast("main", "Copied branch")).toBe(true);
    expect(useToasts.getState().toasts.map((t) => t.text)).toEqual(["Copied branch"]);
  });

  it("never claims a copy that did not happen; Show text opens the text for copying by hand", async () => {
    setClipboard(undefined);
    setExecCommand(() => false);
    render(<ToastHost />);
    let ok = true;
    await act(async () => {
      ok = await copyWithToast("claude --resume abc", "Copied: claude --resume abc");
    });
    expect(ok).toBe(false);
    expect(screen.queryByText(/^Copied/)).toBeNull();
    expect(screen.getByText(COPY_UNAVAILABLE)).toBeDefined();
    fireEvent.click(screen.getByText("Show text"));
    const area = screen.getByLabelText("Text to copy") as HTMLTextAreaElement;
    expect(area.value).toBe("claude --resume abc");
    expect(document.activeElement).toBe(area);
    fireEvent.click(screen.getByText("Done"));
    expect(screen.queryByLabelText("Text to copy")).toBeNull();
  });
});
