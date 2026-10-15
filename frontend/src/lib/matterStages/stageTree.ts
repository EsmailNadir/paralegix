/**
 * Pure helpers for the matter-stage tree: assemble a flat stage list into a
 * forest, compute a tidy top-down layout (columns + depth), and produce a
 * parent-before-child order for aggregate persistence and validation.
 */

export interface TreeInput {
  id: string;
  parentId: string | null;
  sortOrder?: number;
}

export interface TreeNode<T extends TreeInput = TreeInput> {
  id: string;
  data: T;
  children: TreeNode<T>[];
}

export interface LaidOutNode {
  id: string;
  col: number; // horizontal slot (leaves are integers, parents are centered means)
  depth: number; // row (0 at the root)
}

/** Group a flat list into a forest. Unknown/missing parents become roots.
 *  Cycles are broken defensively so every node appears exactly once. */
export function buildForest<T extends TreeInput>(items: T[]): TreeNode<T>[] {
  const byId = new Map<string, TreeNode<T>>();
  for (const it of items) byId.set(it.id, { id: it.id, data: it, children: [] });

  const parentOf = new Map<string, string | null>();
  for (const it of items) parentOf.set(it.id, it.parentId ?? null);

  const isAncestor = (candidateAncestorId: string, nodeId: string): boolean => {
    let cur = parentOf.get(nodeId) ?? null;
    const seen = new Set<string>();
    while (cur) {
      if (cur === candidateAncestorId) return true;
      if (seen.has(cur)) return false;
      seen.add(cur);
      cur = parentOf.get(cur) ?? null;
    }
    return false;
  };

  const roots: TreeNode<T>[] = [];
  for (const it of items) {
    const node = byId.get(it.id)!;
    const parent = it.parentId ? byId.get(it.parentId) : undefined;
    // Attach to parent only if the parent exists and this wouldn't create a cycle.
    if (parent && it.parentId !== it.id && !isAncestor(it.id, it.parentId!)) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  const bySort = (a: TreeNode<T>, b: TreeNode<T>) =>
    (a.data.sortOrder ?? 0) - (b.data.sortOrder ?? 0);
  const sortRec = (n: TreeNode<T>) => {
    n.children.sort(bySort);
    n.children.forEach(sortRec);
  };
  roots.sort(bySort);
  roots.forEach(sortRec);
  return roots;
}

/** Assign each node a column (x slot) and depth (row) for a tidy top-down tree. */
export function layoutForest<T extends TreeInput>(roots: TreeNode<T>[]): LaidOutNode[] {
  const out: LaidOutNode[] = [];
  let nextLeafCol = 0;

  const assign = (node: TreeNode<T>, depth: number): number => {
    let col: number;
    if (node.children.length === 0) {
      col = nextLeafCol;
      nextLeafCol += 1;
    } else {
      const childCols = node.children.map((c) => assign(c, depth + 1));
      col = (childCols[0] + childCols[childCols.length - 1]) / 2;
    }
    out.push({ id: node.id, col, depth });
    return col;
  };

  roots.forEach((r) => assign(r, 0));
  return out;
}

/** Parent-before-child ordering (pre-order DFS over the forest). */
export function topoOrder<T extends TreeInput>(items: T[]): T[] {
  const roots = buildForest(items);
  const out: T[] = [];
  const walk = (node: TreeNode<T>) => {
    out.push(node.data);
    node.children.forEach(walk);
  };
  roots.forEach(walk);
  return out;
}
