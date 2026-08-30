import { create } from "zustand";

export interface ToastItem {
  id: number;
  text: string;
}

interface ToastState {
  toasts: ToastItem[];
}

export const useToasts = create<ToastState>(() => ({ toasts: [] }));

let nextId = 1;
const DISMISS_MS = 3000;

/** Transient confirmation ("Copied: claude --resume …"). Auto-dismisses. */
export function showToast(text: string): void {
  const id = nextId++;
  useToasts.setState((s) => ({ toasts: [...s.toasts, { id, text }] }));
  setTimeout(() => dismissToast(id), DISMISS_MS);
}

export function dismissToast(id: number): void {
  useToasts.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}
