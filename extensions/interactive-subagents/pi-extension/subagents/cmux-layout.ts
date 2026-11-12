/**
 * The cmux agents workspace's panes as cmux's binary split tree, with one
 * child surface per leaf. cmux cannot report pane sizes for a workspace that
 * was never on screen, so the tree tracks them: every split halves a pane, and
 * closing a pane gives its space back to its sibling.
 */
export type CmuxSplitDirection = "right" | "down";

export type CmuxLayoutNode =
  | { surface: string }
  | { direction: CmuxSplitDirection; first: CmuxLayoutNode; second: CmuxLayoutNode };

/** Width over height of the workspace, assumed wider than tall like most windows. */
const WORKSPACE_ASPECT = 1.6;

interface Leaf {
  surface: string;
  width: number;
  height: number;
}

function leaves(node: CmuxLayoutNode, width = WORKSPACE_ASPECT, height = 1): Leaf[] {
  if ("surface" in node) return [{ surface: node.surface, width, height }];
  return node.direction === "right"
    ? [...leaves(node.first, width / 2, height), ...leaves(node.second, width / 2, height)]
    : [...leaves(node.first, width, height / 2), ...leaves(node.second, width, height / 2)];
}

/**
 * Where the next child goes: split the largest pane (the first one on a tie)
 * across its longer side. From one full pane this fills a 2x2 grid in the
 * order top-left, top-right, bottom-left, bottom-right.
 */
export function planCmuxSplit(tree: CmuxLayoutNode): { from: string; direction: CmuxSplitDirection } {
  const target = leaves(tree).reduce((best, leaf) =>
    leaf.width * leaf.height > best.width * best.height ? leaf : best,
  );
  return { from: target.surface, direction: target.width >= target.height ? "right" : "down" };
}

export function addCmuxSplit(
  tree: CmuxLayoutNode,
  from: string,
  direction: CmuxSplitDirection,
  surface: string,
): CmuxLayoutNode {
  if ("surface" in tree) {
    return tree.surface === from ? { direction, first: tree, second: { surface } } : tree;
  }
  return {
    ...tree,
    first: addCmuxSplit(tree.first, from, direction, surface),
    second: addCmuxSplit(tree.second, from, direction, surface),
  };
}

export function removeCmuxPane(tree: CmuxLayoutNode, surface: string): CmuxLayoutNode | null {
  if ("surface" in tree) return tree.surface === surface ? null : tree;
  const first = removeCmuxPane(tree.first, surface);
  const second = removeCmuxPane(tree.second, surface);
  if (!first) return second;
  if (!second) return first;
  return { ...tree, first, second };
}
