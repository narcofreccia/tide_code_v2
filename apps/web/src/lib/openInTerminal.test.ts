import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openThreadTerminal, runInThreadTerminal } from "./openInTerminal.ts";
import { createPty, livePurposeTab, setActivePty, setDrawerOpen, writePty, ensurePtys } from "../state/terminals.ts";
import { useUi } from "../state/ui.ts";
import { useMobileNav } from "../components/mobile/mobileNav.ts";

vi.mock("../state/terminals.ts", () => ({
  createPty: vi.fn(),
  ensurePtys: vi.fn(async () => undefined),
  livePurposeTab: vi.fn(),
  setActivePty: vi.fn(),
  setDrawerOpen: vi.fn(),
  writePty: vi.fn(),
}));
vi.mock("./threadActions.ts", () => ({
  copyTerminalCommand: vi.fn(),
  fetchTerminalCommand: vi.fn(async () => "claude --resume s1"),
}));
vi.mock("../state/toast.ts", () => ({ showToast: vi.fn() }));

function mockMedia(matches: boolean) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches, addEventListener: () => {}, removeEventListener: () => {} })));
}

beforeEach(() => {
  vi.mocked(createPty).mockResolvedValue("pty-1");
  vi.mocked(livePurposeTab).mockReturnValue(undefined);
  useUi.setState({ selectedThreadId: "a", focusMode: "split", view: "thread" });
  useMobileNav.setState({ inboxOpen: true, codeOpen: false, sheetOpen: false });
  mockMedia(false);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("openInTerminal", () => {
  it("selects the thread first when the action targets another thread", async () => {
    await runInThreadTerminal("b", "claude --resume s2");
    expect(useUi.getState().selectedThreadId).toBe("b");
    expect(createPty).toHaveBeenCalledWith("b", 80, 24, undefined);
    expect(writePty).toHaveBeenCalledWith("pty-1", "claude --resume s2\n");
  });

  it("leaves the selection alone when the thread is already selected", async () => {
    await runInThreadTerminal("a", "ls");
    expect(useUi.getState().selectedThreadId).toBe("a");
    expect(useUi.getState().view).toBe("thread");
  });

  it("shows the thread of an existing resume terminal", async () => {
    vi.mocked(livePurposeTab).mockReturnValue({ ptyId: "pty-r" } as never);
    await openThreadTerminal("b");
    expect(useUi.getState().selectedThreadId).toBe("b");
    expect(ensurePtys).not.toHaveBeenCalled();
    expect(setActivePty).toHaveBeenCalledWith("b", "pty-r");
    expect(setDrawerOpen).toHaveBeenCalledWith(true);
  });

  it("reveals the drawer without opening the Code sheet on desktop", async () => {
    await runInThreadTerminal("a", "ls");
    expect(setDrawerOpen).toHaveBeenCalledWith(true);
    expect(useMobileNav.getState().codeOpen).toBe(false);
  });

  it("opens the Code sheet with the drawer on a phone viewport", async () => {
    mockMedia(true);
    await runInThreadTerminal("a", "ls");
    expect(setDrawerOpen).toHaveBeenCalledWith(true);
    expect(useMobileNav.getState().codeOpen).toBe(true);
  });
});
