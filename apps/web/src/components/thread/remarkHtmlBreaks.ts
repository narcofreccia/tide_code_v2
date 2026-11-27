/**
 * Agents write `<br>` for line breaks inside GFM table cells (a cell cannot hold a newline).
 * Raw HTML stays off, so turn just that tag into a markdown break instead of showing it as text.
 */
interface Node {
  type: string;
  value?: string;
  children?: Node[];
}

const BR = /^<br\s*\/?>$/i;

function walk(node: Node): void {
  if (node.children === undefined) return;
  for (let i = 0; i < node.children.length; i++) {
    const child = node.children[i] as Node;
    if (child.type === "html" && BR.test((child.value ?? "").trim())) node.children[i] = { type: "break" };
    else walk(child);
  }
}

export function remarkHtmlBreaks() {
  return (tree: Node): void => walk(tree);
}
