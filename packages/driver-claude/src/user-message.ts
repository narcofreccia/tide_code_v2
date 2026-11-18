import { randomUUID } from "node:crypto";
import type { TurnInput } from "@tide/contracts";

/** A user message pushed into the streaming-input prompt (a send or a steer), with its own uuid. */
export interface UserMessageEnvelope {
  type: "user";
  message: { role: "user"; content: string | Record<string, unknown>[] };
  parent_tool_use_id: null;
  session_id: string;
  uuid: string;
}

export function buildUserMessage(input: TurnInput, sessionId: string): UserMessageEnvelope {
  const images = input.images ?? [];
  const content =
    images.length === 0
      ? input.text
      : [
          ...images.map((image) => ({ type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } })),
          { type: "text", text: input.text },
        ];
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() };
}
