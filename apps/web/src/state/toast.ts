import { create } from "zustand";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  text: string;
  action?: ToastAction;
}

interface ToastState {
  toasts: ToastItem[];
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }));

let nextId = 1;
const DISMISS_MS = 3000;
/** a toast that offers Undo stays long enough to reach for it */
export const ACTION_DISMISS_MS = 6000;

/** Transient confirmation ("Copied: claude --resume …"). Auto-dismisses; an action keeps it up longer. */
export function showToast(text: string, action?: ToastAction, opts: { ms?: number } = {}): number {
  const id = nextId++;
  useToasts.setState((s) => ({ toasts: [...s.toasts, { id, text, ...(action ? { action } : {}) }] }));
  setTimeout(() => dismissToast(id), opts.ms ?? (action ? ACTION_DISMISS_MS : DISMISS_MS));
  return id;
}

/** True while the toast is still on screen. */
export function isToastLive(id: number): boolean {
  return useToasts.getState().toasts.some((t) => t.id === id);
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
