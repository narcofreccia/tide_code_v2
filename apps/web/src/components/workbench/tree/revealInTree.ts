import { selectRow, setExpanded } from "../../../state/files.ts";
import { setTreeVisible } from "../../../state/workbench.ts";

/** Opens the file tree with `dir` and its ancestors expanded and `dir` selected (FileTree scrolls to it). */
export function revealInTree(threadId: string, dir: string): void {
  setTreeVisible(true);
  const parts = dir.split("/").filter(Boolean);
  for (let i = 1; i <= parts.length; i++) setExpanded(threadId, parts.slice(0, i).join("/"), true);
  selectRow(threadId, parts.join("/"));
}
