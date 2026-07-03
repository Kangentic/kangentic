import { describe, it, expect } from 'vitest';
import { layoutCommitGraph, type CommitGraphInputCommit } from '../../src/renderer/lib/commit-graph-layout';

// Unit coverage for the pure lane-assignment walk that drives the commit-graph
// DAG (src/renderer/lib/commit-graph-layout.ts). Hand-built topo-ordered
// fixtures (newest first), no git, so the layout logic is verified in isolation.

/** Look up the single edge from `from` to `to`. */
function edge(layout: ReturnType<typeof layoutCommitGraph>, from: string, to: string) {
  return layout.edges.find((candidate) => candidate.fromHash === from && candidate.toHash === to);
}

/** Look up a node's assigned lane. */
function laneOf(layout: ReturnType<typeof layoutCommitGraph>, hash: string): number | undefined {
  return layout.nodes.find((node) => node.hash === hash)?.lane;
}

describe('layoutCommitGraph', () => {
  it('returns an empty layout for empty input', () => {
    const layout = layoutCommitGraph([]);
    expect(layout.nodes).toEqual([]);
    expect(layout.edges).toEqual([]);
    expect(layout.laneCount).toBe(0);
  });

  it('lays out linear history in a single lane', () => {
    const commits: CommitGraphInputCommit[] = [
      { hash: 'c3', parents: ['c2'] },
      { hash: 'c2', parents: ['c1'] },
      { hash: 'c1', parents: [] },
    ];
    const layout = layoutCommitGraph(commits);

    expect(layout.laneCount).toBe(1);
    expect(layout.nodes.every((node) => node.lane === 0)).toBe(true);
    expect(layout.nodes.map((node) => node.row)).toEqual([0, 1, 2]);
    // Two resolved edges down the single lane, none dangling.
    expect(layout.edges).toHaveLength(2);
    expect(layout.edges.every((candidate) => !candidate.danglingParent)).toBe(true);
    expect(edge(layout, 'c3', 'c2')).toMatchObject({ fromLane: 0, toLane: 0, fromRow: 0, toRow: 1 });
  });

  it('allocates a second lane for a branch and converges at the merge base', () => {
    // M(merge of A,B) -> A -> B -> C(shared parent)
    const commits: CommitGraphInputCommit[] = [
      { hash: 'm', parents: ['a', 'b'] },
      { hash: 'a', parents: ['c'] },
      { hash: 'b', parents: ['c'] },
      { hash: 'c', parents: [] },
    ];
    const layout = layoutCommitGraph(commits);

    expect(layout.laneCount).toBe(2);
    // The merge commit has two edges, one to each of its parents' lanes.
    expect(edge(layout, 'm', 'a')).toMatchObject({ fromLane: 0, toLane: laneOf(layout, 'a') });
    expect(edge(layout, 'm', 'b')).toMatchObject({ fromLane: 0, toLane: laneOf(layout, 'b') });
    expect(laneOf(layout, 'a')).not.toBe(laneOf(layout, 'b'));
    // Both branches converge into c, which sits back in the leftmost lane.
    expect(laneOf(layout, 'c')).toBe(0);
    expect(edge(layout, 'a', 'c')).toBeDefined();
    expect(edge(layout, 'b', 'c')).toBeDefined();
  });

  it('draws one edge per parent for an octopus merge', () => {
    const commits: CommitGraphInputCommit[] = [
      { hash: 'o', parents: ['x', 'y', 'z'] },
      { hash: 'x', parents: [] },
      { hash: 'y', parents: [] },
      { hash: 'z', parents: [] },
    ];
    const layout = layoutCommitGraph(commits);

    const octopusEdges = layout.edges.filter((candidate) => candidate.fromHash === 'o');
    expect(octopusEdges).toHaveLength(3);
    expect(new Set(octopusEdges.map((candidate) => candidate.toHash))).toEqual(new Set(['x', 'y', 'z']));
    // Three distinct parent lanes.
    expect(new Set([laneOf(layout, 'x'), laneOf(layout, 'y'), laneOf(layout, 'z')]).size).toBe(3);
    expect(layout.laneCount).toBe(3);
  });

  it('marks an edge to a parent outside the returned set as dangling', () => {
    // Truncated history: the last commit's parent is not in the set.
    const commits: CommitGraphInputCommit[] = [
      { hash: 'c2', parents: ['c1'] },
      { hash: 'c1', parents: ['c0-below-floor'] },
    ];
    const layout = layoutCommitGraph(commits);

    const dangling = edge(layout, 'c1', 'c0-below-floor');
    expect(dangling).toBeDefined();
    expect(dangling?.danglingParent).toBe(true);
    // Routed straight down off the bottom of its lane.
    expect(dangling?.toRow).toBe(layout.nodes.length);
    expect(dangling?.toLane).toBe(dangling?.fromLane);
  });

  it('dedups a merge parent onto an existing lane reservation instead of allocating a new one', () => {
    // Two merge commits (m1, m2) each reserve the SAME not-yet-visited commit
    // ('shared') as their second (merge) parent, before 'shared' has been
    // visited. The `activeLanes.includes(parent) continue` skip must recognize
    // that 'shared' is already reserved (by m1, in lane 1) when m2 tries to
    // reserve it again, and do nothing rather than pushing a second phantom
    // reservation.
    //
    // That phantom would not free itself until 'shared' is finally visited
    // (its "converge" step only fires then), so any commit that needs a fresh
    // lane in the meantime - here 'x', at row 2 - gets pushed one column
    // further right than it should. Traced by hand: with the skip, x lands in
    // lane 3 and laneCount is 4; without it, x lands in lane 4 and laneCount
    // is 5. This is distinct from the "converge at the merge base" test above,
    // which covers freeing lanes AT the point a commit is visited, not
    // deduping a reservation made before it is visited.
    const commits: CommitGraphInputCommit[] = [
      { hash: 'm1', parents: ['a1', 'shared'] },
      { hash: 'm2', parents: ['a2', 'shared'] },
      { hash: 'x', parents: ['y'] },
      { hash: 'y', parents: [] },
      { hash: 'a1', parents: [] },
      { hash: 'a2', parents: [] },
      { hash: 'shared', parents: [] },
    ];
    const layout = layoutCommitGraph(commits);

    expect(layout.laneCount).toBe(4);
    expect(laneOf(layout, 'x')).toBe(3);
    // Both merges' edges to 'shared' converge on the single lane it was
    // (correctly, deduped) reserved in.
    expect(laneOf(layout, 'shared')).toBe(1);
    expect(edge(layout, 'm1', 'shared')).toMatchObject({ toLane: 1 });
    expect(edge(layout, 'm2', 'shared')).toMatchObject({ toLane: 1 });
  });

  it('reuses a lane freed by a root commit for a later independent branch', () => {
    // A -> B(root) frees the lane; C -> D(root) reuses it.
    const commits: CommitGraphInputCommit[] = [
      { hash: 'a', parents: ['b'] },
      { hash: 'b', parents: [] },
      { hash: 'c', parents: ['d'] },
      { hash: 'd', parents: [] },
    ];
    const layout = layoutCommitGraph(commits);

    // Every commit lands in lane 0 (the single lane is freed and reused), so the
    // graph never widens for sequential independent branches.
    expect(layout.laneCount).toBe(1);
    expect(layout.nodes.every((node) => node.lane === 0)).toBe(true);
  });
});
