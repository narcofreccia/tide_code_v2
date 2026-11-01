import type { Thread } from "@tide/contracts";

/** A rail row with its nested children (forks, delegates), resolved once per rail build. */
export interface RailNode {
  thread: Thread;
  children: readonly RailNode[];
}

export const NO_NODES: readonly RailNode[] = [];

/** Delegation wins over the ordinary parent link, so a delegate nests under its caller. */
export function parentOf(thread: Thread): string | undefined {
  return thread.delegatedBy ?? thread.parentThreadId;
}

/** parent id → its children among `threads`, in list order. One pass. */
export function childrenIndex(threads: readonly Thread[]): Map<string, Thread[]> {
  const out = new Map<string, Thread[]>();
  for (const t of threads) {
    const parent = parentOf(t);
    if (parent === undefined) continue;
    const list = out.get(parent);
    if (list === undefined) out.set(parent, [t]);
    else list.push(t);
  }
  return out;
}

function sameNodes(a: readonly RailNode[], b: readonly RailNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Builds rail nodes and keeps the previous build's node objects (and children
 * arrays) wherever nothing under them changed, so memoized rows skip re-rendering.
 * `scope` separates the same thread drawn in two places (a session and a group).
 */
export class RailTreeBuilder {
  private prev = new Map<string, RailNode>();
  private next = new Map<string, RailNode>();
  private lists = new Map<string, readonly RailNode[]>();

  /** Call once per build, before `node`/`roots`; drops nodes the last build did not reuse. */
  begin(): void {
    this.prev = this.next.size > 0 ? this.next : this.prev;
    this.next = new Map();
  }

  node(scope: string, thread: Thread, index: ReadonlyMap<string, readonly Thread[]>, seen: Set<string> = new Set()): RailNode {
    seen.add(thread.id);
    const kids = (index.get(thread.id) ?? []).filter((c) => !seen.has(c.id));
    const children = kids.length === 0 ? NO_NODES : kids.map((c) => this.node(scope, c, index, seen));
    const key = `${scope}\u0000${thread.id}`;
    const was = this.prev.get(key) ?? this.next.get(key);
    const node = was !== undefined && was.thread === thread && sameNodes(was.children, children) ? was : { thread, children };
    this.next.set(key, node);
    return node;
  }

  /** `list` as nodes, reusing the previous array when every node is the same. */
  list(scope: string, threads: readonly Thread[], index: ReadonlyMap<string, readonly Thread[]>): readonly RailNode[] {
    const nodes = threads.map((t) => this.node(scope, t, index));
    const key = `${scope}\u0000[list]`;
    const was = this.lists.get(key);
    const out = was !== undefined && sameNodes(was, nodes) ? was : nodes.length === 0 ? NO_NODES : nodes;
    this.lists.set(key, out);
    return out;
  }
}

/** The children nodes of `threadId` among `siblings`: the path for callers without a prebuilt tree. */
export function childNodesIn(siblings: readonly Thread[], threadId: string): readonly RailNode[] {
  const index = childrenIndex(siblings);
  const seen = new Set([threadId]);
  const build = (t: Thread): RailNode => {
    seen.add(t.id);
    const kids = (index.get(t.id) ?? []).filter((c) => !seen.has(c.id));
    return { thread: t, children: kids.length === 0 ? NO_NODES : kids.map(build) };
  };
  const kids = index.get(threadId) ?? [];
  return kids.length === 0 ? NO_NODES : kids.map(build);
}
