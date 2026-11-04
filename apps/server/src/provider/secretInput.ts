import type { Activity, EventOf, ReadModel } from "@tide/contracts";

/**
 * R16: a secret card is raised by Tide's own tide_request_secret, not by the harness, so its
 * answer must not be forwarded to the driver (the harness never saw that request id).
 */
export function isSecretResponse(model: ReadModel, event: EventOf<"user-input.responded">): boolean {
  if (event.requestId.startsWith("secret:")) return true;
  const activity = event.activityId === undefined ? undefined : model.activities[event.activityId];
  return activity?.kind === "user-input" && activity.secret === true;
}

const SECRET_TOOL = /(^|__)tide_request_secret$/;
const REDACTED = "(value redacted by Tide: the harness received it, the record keeps only this note)";

/**
 * The harness echoes every tool result back as a tool activity, and tide_request_secret's result
 * carries the secret itself. Nothing past this point may hold it: the output is replaced before
 * the activity reaches the event log, the model and every client.
 */
export function redactSecretTool(activity: Activity): Activity {
  if (activity.kind !== "tool" || !SECRET_TOOL.test(activity.toolName) || activity.output === undefined) return activity;
  const head = activity.output.split("\n", 1)[0] ?? "";
  return { ...activity, output: `${head}\n${REDACTED}` };
}
