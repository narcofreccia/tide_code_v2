import { createHash, createHmac } from "node:crypto";
import type { ScheduledTask } from "@tide/contracts";
import { CommandError, type Engine } from "../orchestration/engine.ts";
import { safeEqual } from "../rpc/pairing.ts";
import type { SettingsStore } from "../settings.ts";

export const WEBHOOK_MAX_BODY = 64 * 1024;
export const WEBHOOK_PROMPT_MAX = 8 * 1024;
export const SIGNATURE_HEADER = "x-tide-signature";

export interface WebhookDeps {
  engine: Engine;
  settings?: Pick<SettingsStore, "get">;
  log?: (msg: string, data?: unknown) => void;
}

export interface WebhookResult {
  status: number;
  /** JSON text */
  body: string;
}

type Headers = Record<string, string | string[] | undefined>;

const reply = (status: number, body: Record<string, unknown>): WebhookResult => ({ status, body: JSON.stringify(body) });

function header(headers: Headers, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export function findWebhookTask(engine: Engine, hookId: string): ScheduledTask | undefined {
  return Object.values(engine.getModel().scheduledTasks).find(
    (t) => t.enabled && t.archivedAt === undefined && t.schedule.kind === "webhook" && t.schedule.hookId === hookId,
  );
}

export function signBody(secret: string, body: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * The payload as the agent sees it: a fenced block (longer fence when the body has backticks),
 * cut at 8 KB on a UTF-8 boundary.
 */
export function payloadBlock(body: Buffer, contentType: string | undefined): string {
  if (body.length === 0) return "Webhook fired (empty body).";
  let text = body.subarray(0, WEBHOOK_PROMPT_MAX).toString("utf8");
  if (body.length > WEBHOOK_PROMPT_MAX) text = `${text.replace(/�$/, "")}\n… (truncated, ${body.length} bytes total)`;
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(longest + 1);
  const lang = contentType?.includes("json") ? "json" : "";
  return `Webhook payload:\n${fence}${lang}\n${text}\n${fence}`;
}

/**
 * `POST /hook/<hookId>`, shared by the HTTP route and the relay client. Unknown or paused hooks
 * are 404; a task with a secret needs `X-Tide-Signature: sha256=<hex hmac of the raw body>`.
 * The commandId hashes the body, so a retried delivery of the same payload is a receipt replay.
 */
export async function handleWebhook(deps: WebhookDeps, hookId: string, rawBody: Buffer | string, headers: Headers): Promise<WebhookResult> {
  const body = typeof rawBody === "string" ? Buffer.from(rawBody, "utf8") : rawBody;
  if (body.length > WEBHOOK_MAX_BODY) return reply(413, { error: "payload-too-large" });
  const task = findWebhookTask(deps.engine, hookId);
  if (!task || task.schedule.kind !== "webhook") return reply(404, { error: "not-found" });
  const secret = task.schedule.secret;
  if (secret !== undefined) {
    const given = header(headers, SIGNATURE_HEADER) ?? "";
    if (!safeEqual(given.trim().toLowerCase(), signBody(secret, body))) return reply(401, { error: "bad-signature" });
  }
  const digest = createHash("sha256").update(body).digest("hex").slice(0, 16);
  try {
    const result = await deps.engine.dispatch({
      type: "task.fire",
      commandId: `hook:${hookId}:${digest}`,
      taskId: task.id,
      useWorktreeDefault: deps.settings?.get().worktreeByDefault ?? true,
      promptSuffix: payloadBlock(body, header(headers, "content-type")),
    });
    const fired = result.events.map((r) => r.event).find((e) => e.type === "task.fired");
    return reply(200, { ok: true, taskId: task.id, ...(fired?.type === "task.fired" ? { threadId: fired.threadId, turnId: fired.turnId } : {}) });
  } catch (err) {
    if (err instanceof CommandError) return reply(err.code === "not-found" ? 404 : 409, { error: err.code, message: err.message });
    deps.log?.("[webhook] fire failed", err);
    return reply(500, { error: "internal" });
  }
}
