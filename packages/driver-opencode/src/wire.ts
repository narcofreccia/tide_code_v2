/**
 * The slice of OpenCode 2's HTTP API this driver reads.
 *
 * Event shapes come straight from the SDK's generated types (`OpenCodeEvent` re-exported by
 * `@opencode/sdk` 2.0.27 from `@opencode/client`), imported type-only so nothing of the
 * in-process host is loaded at runtime. Request/response bodies are hand-written from the
 * server's own OpenAPI document (`GET /openapi.json` on `opencode serve` 2.0.27): the SDK's
 * Promise surface is typed through the embedded host and does not narrow request bodies.
 *
 * Unknown events stay open-ended (`{ type: string }`) so a new server release is passed
 * through as an info row instead of being dropped (CLAUDE.md §1a).
 */
import type { OpenCodeEvent } from "@opencode/sdk";

export type KnownEvent = OpenCodeEvent;
export type EventOf<T extends KnownEvent["type"]> = Extract<KnownEvent, { type: T }>;

/** What the SSE stream yields: a known event, or anything a newer server invents. */
export type OpencodeEvent = KnownEvent | { type: string; id?: string; data?: unknown; location?: { directory: string } };

export type PermissionEffect = "allow" | "deny" | "ask";

/** `Permission.Rule` (v2): evaluated with `findLast` over `[...agent.permissions, ...session.permissions]`. */
export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}

/** `Permission.Reply`. `always` persists a project-wide saved rule (`permission/saved`). */
export type PermissionReply = "once" | "always" | "reject";

export interface WireTokens {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
}

export interface ModelRef {
  providerID: string;
  /** v2 calls the model id `id` (v1: `modelID`) */
  id: string;
  variant?: string;
}

/** `Session.Info` — `cost`/`tokens` are the session's cumulative totals. */
export interface WireSession {
  id: string;
  projectID: string;
  agent?: string;
  model?: ModelRef;
  cost: number;
  tokens: WireTokens;
  permissions?: PermissionRule[];
  location: { directory: string };
  title?: string;
}

/** `Model.Info` from `GET /api/model` (only the fields Tide reads). */
export interface WireModel {
  id: string;
  modelID?: string;
  providerID: string;
  name: string;
  family?: string;
  enabled?: boolean;
  status?: string;
  limit?: { context?: number; output?: number };
}

/** `Agent.Info` from `GET /api/agent`; `permissions` is the fully resolved ruleset. */
export interface WireAgent {
  id: string;
  name: string;
  description?: string;
  mode: "subagent" | "primary" | "all";
  hidden: boolean;
  permissions?: PermissionRule[];
}

/**
 * One `Config.Entry` from `GET /api/config` (a config document or directory, in load order).
 * Only the keys Tide reads; `permissions` is already the v2 ordered ruleset.
 */
export interface WireConfigEntry {
  type: "document" | "directory" | (string & {});
  path?: string;
  info?: {
    default_agent?: string;
    permissions?: PermissionRule[];
    agents?: Record<string, { permissions?: PermissionRule[]; disabled?: boolean }>;
  };
}

/** `Form.Field` (the subset Tide renders); a question tool call creates a form. */
export interface WireFormField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external" | (string & {});
  title?: string;
  description?: string;
  options?: { value: string; label: string; description?: string }[];
  custom?: boolean;
}

export interface WireForm {
  id: string;
  sessionID: string;
  title: string;
  metadata?: Record<string, unknown>;
  fields: WireFormField[];
}

export type FormValue = string | number | boolean | string[];
