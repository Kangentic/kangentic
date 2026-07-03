/**
 * Pure lane-assignment for the commit-graph DAG. Given topo-ordered commits
 * (newest first) with their parent links, assigns each commit an integer lane
 * (column) and produces the edges to draw to each parent. No React, no git - a
 * pure function so it unit-tests with hand-built fixtures (precedent:
 * `src/renderer/lib/datetime.ts`).
 *
 * Algorithm: the standard "active lanes" walk. `activeLanes[i]` holds the hash a
 * lane is currently waiting for (a reserved pending parent). Walking newest to
 * oldest, each commit claims the leftmost lane reserved for it (or a fresh one),
 * frees any other lanes that were also waiting for it (merges converge), then
 * reserves its parents: the first parent continues straight down in the commit's
 * lane, additional (merge) parents dedupe onto an existing reservation or take a
 * new lane.
 */

/** Minimal commit shape the layout needs (a subset of GitCommitGraphCommit). */
export interface CommitGraphInputCommit {
  hash: string;
  parents: string[];
}

export interface CommitGraphNode {
  hash: string;
  /** Vertical position: index in the input order. */
  row: number;
  /** Horizontal column. */
  lane: number;
}

export interface CommitGraphEdge {
  fromHash: string;
  toHash: string;
  fromLane: number;
  toLane: number;
  fromRow: number;
  toRow: number;
  /** True when the parent is below the returned set (truncated / below the base floor). */
  danglingParent: boolean;
}

export interface CommitGraphLayout {
  /** One node per input commit, in input order. */
  nodes: CommitGraphNode[];
  edges: CommitGraphEdge[];
  /** Number of columns needed (max lane + 1); 0 for empty input. */
  laneCount: number;
}

/** Reserve `hash` in the first free (null) lane, growing the array if none is free. */
function reserveFreeLane(activeLanes: (string | null)[], hash: string): number {
  const free = activeLanes.indexOf(null);
  if (free !== -1) {
    activeLanes[free] = hash;
    return free;
  }
  activeLanes.push(hash);
  return activeLanes.length - 1;
}

export function layoutCommitGraph(commits: CommitGraphInputCommit[]): CommitGraphLayout {
  const nodes: CommitGraphNode[] = [];
  const nodeByHash = new Map<string, CommitGraphNode>();
  const activeLanes: (string | null)[] = [];

  commits.forEach((commit, row) => {
    // 1. Lane for this commit: the leftmost lane a child reserved for it, else a
    //    fresh lane (this commit is the head of a branch no child pointed to).
    let lane = activeLanes.indexOf(commit.hash);
    if (lane === -1) {
      lane = reserveFreeLane(activeLanes, commit.hash);
    }

    // 2. Converge: free every OTHER lane that was also waiting for this commit
    //    (a merge target reserved by multiple children). Keep the leftmost.
    for (let index = 0; index < activeLanes.length; index += 1) {
      if (index !== lane && activeLanes[index] === commit.hash) {
        activeLanes[index] = null;
      }
    }

    const node: CommitGraphNode = { hash: commit.hash, row, lane };
    nodes.push(node);
    nodeByHash.set(commit.hash, node);

    // 3. Reserve parents. First parent continues straight down in this lane;
    //    extra (merge) parents dedupe onto an existing reservation or take a new
    //    lane. A root commit (no parents) frees its lane.
    if (commit.parents.length === 0) {
      activeLanes[lane] = null;
    } else {
      activeLanes[lane] = commit.parents[0];
      for (let index = 1; index < commit.parents.length; index += 1) {
        const parent = commit.parents[index];
        if (activeLanes.includes(parent)) continue;
        reserveFreeLane(activeLanes, parent);
      }
    }
  });

  const edges: CommitGraphEdge[] = [];
  for (const node of nodes) {
    const commit = commits[node.row];
    for (const parent of commit.parents) {
      const parentNode = nodeByHash.get(parent);
      if (parentNode) {
        edges.push({
          fromHash: node.hash,
          toHash: parent,
          fromLane: node.lane,
          toLane: parentNode.lane,
          fromRow: node.row,
          toRow: parentNode.row,
          danglingParent: false,
        });
      } else {
        // Parent below the returned set: route the line straight down off the
        // bottom of the commit's lane so it visibly continues off-screen.
        edges.push({
          fromHash: node.hash,
          toHash: parent,
          fromLane: node.lane,
          toLane: node.lane,
          fromRow: node.row,
          toRow: nodes.length,
          danglingParent: true,
        });
      }
    }
  }

  const laneCount = nodes.reduce((max, node) => Math.max(max, node.lane), -1) + 1;
  return { nodes, edges, laneCount };
}
