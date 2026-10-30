import type { Engine } from "../orchestration/engine.ts";
import { saveAttachments } from "../workspace/attachments.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export interface AttachmentDeps {
  engine: Engine;
  /** thread -> cwd (worktree path, else project root) */
  cwdFor: (threadId: string) => string;
}

/** `attachments.upload`: files land in `<thread cwd>/.tide/attachments/<id>/`, excluded from git. */
export function registerAttachmentHandlers(router: RpcRouter, deps: AttachmentDeps): void {
  router.register("attachments.upload", async (input) => {
    if (!deps.engine.getModel().threads[input.threadId]) throw new RpcException("not-found", `unknown thread ${input.threadId}`);
    return { attachments: await saveAttachments(deps.cwdFor(input.threadId), input.files) };
  });
}
