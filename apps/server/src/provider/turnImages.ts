import type { DriverCaps, ImageInput, Message, Project, ReadModel, StoredImage, Thread, TurnInput } from "@tide/contracts";
import { saveInlineImages } from "../workspace/attachments.ts";
import { instanceIdOf, threadCwd } from "./sessions.ts";

// R22: pasted images get a saved copy in the thread's checkout before the harness sees the turn,
// so the model can hand the path to a sub-agent or to another thread (see `attachmentFooter`).

export interface TurnImagesDeps {
  engine: { getModel: () => ReadModel };
  sessions: { caps: (providerId: string) => Promise<Partial<DriverCaps>> };
  log: (msg: string, data?: unknown) => void;
}

type Attachments = Message["attachments"];

/** The prompt (not a steer) that opened `turnId`. */
function promptOf(model: ReadModel, threadId: string, turnId: string): Message | undefined {
  for (const id of model.threadMessages[threadId] ?? []) {
    const m = model.messages[id];
    if (m !== undefined && m.turnId === turnId && m.role === "user" && m.steer !== true) return m;
  }
  return undefined;
}

/**
 * Saves the copies of `attachments`' inline images under `cwd`. When they are saved and the
 * instance does not take images, the pixels are dropped so the footer path is the one route.
 * A failed write is logged and the input is returned unchanged.
 */
async function withSavedCopies(deps: TurnImagesDeps, thread: Thread, cwd: string, attachments: Attachments, input: TurnInput): Promise<TurnInput> {
  if (!(attachments ?? []).some((a) => a.inline === true)) return input;
  try {
    await saveInlineImages(cwd, attachments, input.images);
  } catch (err) {
    deps.log("[reactor] could not save the turn's images", err);
    return input;
  }
  if (input.images === undefined) return input;
  let takesImages: boolean | undefined;
  try {
    takesImages = (await deps.sessions.caps(instanceIdOf(thread))).images;
  } catch (err) {
    deps.log("[reactor] could not read driver caps", err);
    return input;
  }
  if (takesImages === true) return input;
  const { images: _dropped, ...rest } = input;
  return rest;
}

/** For `#runTurn`, after `beforeTurn` attached the worktree (so the cwd is final). */
export function turnImages(deps: TurnImagesDeps, thread: Thread, project: Project, turnId: string, input: TurnInput): Promise<TurnInput> {
  const prompt = promptOf(deps.engine.getModel(), thread.id, turnId);
  return withSavedCopies(deps, thread, threadCwd(thread, project), prompt?.attachments, input);
}

/** For `#steer`, before anything else: a steer that falls back to a turn keeps the paths of its message. */
export function steerImages(deps: TurnImagesDeps, threadId: string, messageId: string, input: TurnInput): Promise<TurnInput> {
  const model = deps.engine.getModel();
  const thread = model.threads[threadId];
  const project = thread !== undefined ? model.projects[thread.projectId] : undefined;
  if (thread === undefined || project === undefined) return Promise.resolve(input);
  return withSavedCopies(deps, thread, threadCwd(thread, project), model.messages[messageId]?.attachments, input);
}

/** Without a blob store only inline images can be handed on (events from before R24, tests). */
export function inlineImages(images: readonly StoredImage[] | undefined): ImageInput[] | undefined {
  return images?.filter((i): i is ImageInput => "data" in i);
}

export function steerInput(text: string, images: ImageInput[] | undefined): TurnInput {
  return { text, ...(images !== undefined && images.length > 0 ? { images } : {}) };
}
