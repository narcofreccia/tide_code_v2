import { create } from "zustand";

/** The "Add machine" sheet can be raised from the palette as well as from Settings › Environments. */
interface FleetUiState {
  /** open, with an optional URL to prefill ("Pair again" on an unauthorized card) */
  addMachine: { url?: string } | null;
}

export const useFleetUi = create<FleetUiState>(() => ({ addMachine: null }));

export function openAddMachine(url?: string): void {
  useFleetUi.setState({ addMachine: url === undefined ? {} : { url } });
}

export function closeAddMachine(): void {
  useFleetUi.setState({ addMachine: null });
}
