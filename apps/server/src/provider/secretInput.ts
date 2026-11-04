import type { EventOf, ReadModel } from "@tide/contracts";

/**
 * R16: a secret card is raised by Tide's own tide_request_secret, not by the harness, so its
 * answer must not be forwarded to the driver (the harness never saw that request id).
 */
export function isSecretResponse(model: ReadModel, event: EventOf<"user-input.responded">): boolean {
  if (event.requestId.startsWith("secret:")) return true;
  const activity = event.activityId === undefined ? undefined : model.activities[event.activityId];
  return activity?.kind === "user-input" && activity.secret === true;
}
