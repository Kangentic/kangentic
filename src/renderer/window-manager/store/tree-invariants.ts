/**
 * The tiling consistency invariant, as a PURE checker (no store, no React).
 *
 * The model (see `types.ts`): floating windows live OUTSIDE the tile tree; a
 * window is referenced by EXACTLY ONE tile leaf iff its `state` is `tiled` - OR it
 * is a `maximized` window that was tiled before it maximized (maximize keeps the
 * leaf + tree membership so un-maximize can return it to its docked slot). A
 * window's `leafId` is non-null iff it is in the tree.
 *
 * A "stale leaf" is any drift from that contract: a tree leaf pointing at a
 * deleted, floating, or snapped window; a `tiled` window missing from the tree; a
 * dangling `leafId`; or a window referenced by two leaves (the duplicate-leaf
 * "invisible wall" - a phantom empty pane the footprint clamps against). Every one
 * of these has shipped as a real bug, each from a different mutator forgetting to
 * evict / clear `leafId` when it flipped a window's state. Rather than re-audit
 * every mutator forever, this one checker is the single source of truth: a dev
 * tripwire runs it after every mutation (window-store) and the unit tests assert it
 * stays empty across every operation, so a future regression fails loudly at its
 * source instead of surfacing three drags later as a mysterious phantom pane.
 */

import type { ManagedWindow, TileNode } from './types';
import { collectWindowIds } from '../tiling/tree-ops';

/**
 * Return a list of human-readable invariant violations for a window/tree state.
 * Empty array = consistent. Stable, deterministic order (duplicates, orphans, then
 * per-window in `Object.values` order) so test assertions and dev logs are stable.
 */
export function findWindowTreeViolations(
  windows: Record<string, ManagedWindow>,
  tileTree: TileNode | null,
): string[] {
  const violations: string[] = [];
  // In-order leaf window ids; repeats here ARE the duplicate-leaf corruption.
  const leafWindowIds = collectWindowIds(tileTree);

  // A tree must have at least two leaves: a lone pane can no longer be "tiled" (a
  // tree needs two), so collapse must clear the tree and snap/float the survivor.
  // A single-leaf tree means a collapse path failed to tear the tree down.
  if (tileTree && leafWindowIds.length < 2) {
    violations.push(`tile tree has ${leafWindowIds.length} leaf (needs >= 2); collapse should have cleared it`);
  }

  // Duplicate leaves: one window referenced by more than one leaf. This is the
  // "invisible wall" - a phantom empty pane the group footprint clamps against.
  const seenLeafIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const windowId of leafWindowIds) {
    if (seenLeafIds.has(windowId)) duplicateIds.add(windowId);
    seenLeafIds.add(windowId);
  }
  for (const windowId of duplicateIds) {
    violations.push(`window ${windowId} is referenced by multiple tile leaves (duplicate leaf)`);
  }

  // Orphan leaves: a leaf references a window that no longer exists.
  for (const windowId of seenLeafIds) {
    if (!windows[windowId]) violations.push(`tile leaf references missing window ${windowId}`);
  }

  // Per-window: state <-> tree-membership <-> leafId must all agree.
  for (const window of Object.values(windows)) {
    const inTree = seenLeafIds.has(window.id);
    if (window.state === 'tiled') {
      if (!inTree) violations.push(`window ${window.id} is 'tiled' but is not in the tile tree`);
      if (!window.leafId) violations.push(`window ${window.id} is 'tiled' but has no leafId`);
    } else if (window.state === 'maximized') {
      // A maximized window MAY be in the tree (it was tiled): then it keeps its
      // leafId. A maximized window OUTSIDE the tree must have no leafId.
      if (inTree && !window.leafId) violations.push(`window ${window.id} is a tiled-maximized pane but has no leafId`);
      if (!inTree && window.leafId) {
        violations.push(`window ${window.id} is 'maximized' outside the tree but still has a leafId (dangling)`);
      }
    } else {
      // floating / snapped: must live OUTSIDE the tree, with no leafId.
      if (inTree) {
        violations.push(`window ${window.id} is '${window.state}' but is still referenced by a tile leaf (stale leaf)`);
      }
      if (window.leafId) violations.push(`window ${window.id} is '${window.state}' but still has a leafId (dangling)`);
    }
  }

  return violations;
}
