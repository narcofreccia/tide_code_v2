import { create } from "zustand";

/**
 * Phone-only navigation state the hash route does not encode.
 * `inboxOpen`: the Mission route shows the Inbox list instead of Mission Control.
 * `codeOpen`: the thread's workbench is full-screen over the thread.
 * `sheetOpen`: the thread settings (⚙) sheet that holds the composer pills.
 */
interface MobileNavState {
  inboxOpen: boolean;
  codeOpen: boolean;
  sheetOpen: boolean;
  setInboxOpen: (open: boolean) => void;
  setCodeOpen: (open: boolean) => void;
  setSheetOpen: (open: boolean) => void;
}

export const useMobileNav = create<MobileNavState>((set) => ({
  inboxOpen: true,
  codeOpen: false,
  sheetOpen: false,
  setInboxOpen: (inboxOpen) => set({ inboxOpen }),
  setCodeOpen: (codeOpen) => set({ codeOpen }),
  setSheetOpen: (sheetOpen) => set({ sheetOpen }),
}));

export function resetMobileNav(): void {
  useMobileNav.setState({ inboxOpen: true, codeOpen: false, sheetOpen: false });
}
