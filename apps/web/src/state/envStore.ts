import { create } from "zustand";
import type { EnvRoute, KnownEnvironment, ServerInfo } from "@tide/contracts";

/**
 * R9: the environments store itself, a leaf module so providers / settings / storage can
 * read it without importing the connection manager. The public face is `environments.ts`.
 */

export type EnvConnection = "connecting" | "connected" | "unauthorized" | "offline";

export interface EnvStatus {
  connection: EnvConnection;
  /** the route that is currently carrying the connection */
  route?: EnvRoute;
  info?: ServerInfo;
  /** last error text when offline / unauthorized */
  error?: string;
  lastSeenAt?: number;
}

export interface EnvironmentsState {
  environments: KnownEnvironment[];
  statuses: Record<string, EnvStatus>;
  primaryId: string | undefined;
}

export const useEnvironments = create<EnvironmentsState>(() => ({
  environments: [],
  statuses: {},
  primaryId: undefined,
}));

/** Ids of the environments whose connection is up, primary first. */
export function connectedEnvIds(state: EnvironmentsState = useEnvironments.getState()): string[] {
  const ids = state.environments.map((e) => e.id).filter((id) => state.statuses[id]?.connection === "connected");
  return ids.sort((a, b) => (a === state.primaryId ? -1 : b === state.primaryId ? 1 : 0));
}
