import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectIcon } from "@tide/contracts";
import type { Engine } from "../orchestration/engine.ts";
import { RpcException, type RpcRouter } from "./router.ts";

export const MAX_ICON_BYTES = 32 * 1024;
const EXT_MIME: Record<string, string> = { svg: "image/svg+xml", ico: "image/x-icon", png: "image/png" };

/** Candidate paths, in priority order. */
export const ICON_CANDIDATES: string[] = [
  ...["svg", "ico", "png"].map((e) => `public/favicon.${e}`),
  ...["ico", "png"].map((e) => `app/favicon.${e}`),
  ...["svg", "ico", "png"].map((e) => `static/favicon.${e}`),
  ...["svg", "ico", "png"].map((e) => `src/assets/favicon.${e}`),
  ...["svg", "ico", "png"].map((e) => `assets/favicon.${e}`),
  ...["svg", "ico", "png"].map((e) => `favicon.${e}`),
  "apple-touch-icon.png",
  ...["svg", "png"].map((e) => `public/icon.${e}`),
  ...["svg", "png"].map((e) => `icon.${e}`),
];

/** First candidate under `root` that is a file ≤ 32 KB, as a data: URL. */
export async function detectIcon(root: string): Promise<{ icon?: ProjectIcon; source?: string }> {
  for (const rel of ICON_CANDIDATES) {
    try {
      const info = await stat(join(root, rel));
      if (!info.isFile() || info.size > MAX_ICON_BYTES || info.size === 0) continue;
      const mime = EXT_MIME[rel.slice(rel.lastIndexOf(".") + 1)] as string;
      const bytes = await readFile(join(root, rel));
      return { icon: { kind: "data", value: `data:${mime};base64,${bytes.toString("base64")}` }, source: rel };
    } catch {
      // not there
    }
  }
  return {};
}

export function registerProjectIconHandlers(router: RpcRouter, deps: { engine: Engine }): void {
  router.register("project.detectIcon", async (input) => {
    const project = deps.engine.getModel().projects[input.projectId];
    if (!project) throw new RpcException("not-found", `unknown project ${input.projectId}`);
    return detectIcon(project.rootPath);
  });
}
