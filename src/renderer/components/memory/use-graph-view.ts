/**
 * What the Memory Graph body draws: the open project's snapshot, or several
 * projects' maps composed into islands.
 *
 * One effective snapshot either way, so the body, the canvas and the controls
 * read a single shape. With no scope set (the default) this is the store's own
 * snapshot, untouched, which keeps the single-project path exactly as it was.
 */

import { useMemo } from 'react';
import { useMemoryGraphStore } from '../../stores/memory-graph-store';
import type {
  MemoryCoverageBucket,
  MemoryCoverageSummary,
  MemoryGraphGranularity,
  MemoryGraphSnapshot,
} from '../../../shared/types';
import { composeIslands, type Island, type IslandSource } from './compose-islands';

export interface GraphView {
  snapshot: MemoryGraphSnapshot | null;
  /** The islands, when two or more projects' maps are composed; else null. */
  islands: Island[] | null;
  /** The project each node belongs to, by node index, when a scope is set. */
  nodeProjectIds: string[] | null;
  /** The project each region belongs to, per granularity, when composed. */
  regionProjectNames: Partial<Record<MemoryGraphGranularity, string[]>> | null;
  /** Scoped projects whose map is not drawable yet: still loading, or building. */
  pendingProjectIds: string[];
  /** How many unit boxes wide the drawn map is: 1 unless islands are composed.
   *  The camera's reach scales with it (`compose-islands.ts`). */
  worldExtent: number;
}

function addBuckets(first: MemoryCoverageBucket, second: MemoryCoverageBucket): MemoryCoverageBucket {
  const tones: Array<MemoryCoverageBucket['tone']> = ['ok', 'neutral', 'problem'];
  return {
    documents: first.documents + second.documents,
    chunks: first.chunks + second.chunks,
    // The worse of the two, so a problem in one project is not averaged away.
    tone: tones[Math.max(tones.indexOf(first.tone), tones.indexOf(second.tone))],
  };
}

/** Coverage across projects: every count summed, the embedded share recomputed. */
export function sumCoverage(summaries: ReadonlyArray<MemoryCoverageSummary>): MemoryCoverageSummary {
  const [first, ...rest] = summaries;
  const total = rest.reduce<MemoryCoverageSummary>((sum, next) => ({
    indexed: addBuckets(sum.indexed, next.indexed),
    sourceMissingButSearchable: addBuckets(sum.sourceMissingButSearchable, next.sourceMissingButSearchable),
    empty: addBuckets(sum.empty, next.empty),
    failed: addBuckets(sum.failed, next.failed),
    notYetIndexed: addBuckets(sum.notYetIndexed, next.notYetIndexed),
    totalDocumentsWithChunks: sum.totalDocumentsWithChunks + next.totalDocumentsWithChunks,
    totalChunks: sum.totalChunks + next.totalChunks,
    totalEmbeddedChunks: sum.totalEmbeddedChunks + next.totalEmbeddedChunks,
    embeddedFraction: 0,
    knownDocumentIdsMatched: sum.knownDocumentIdsMatched + next.knownDocumentIdsMatched,
  }), first);
  return { ...total, embeddedFraction: total.totalChunks > 0 ? total.totalEmbeddedChunks / total.totalChunks : 0 };
}

export function useGraphView(): GraphView {
  const snapshot = useMemoryGraphStore((state) => state.snapshot);
  const openProjectId = useMemoryGraphStore((state) => state.projectId);
  const scope = useMemoryGraphStore((state) => state.scopeProjectIds);
  const scopeSnapshots = useMemoryGraphStore((state) => state.scopeSnapshots);
  const projects = useMemoryGraphStore((state) => state.projects);

  // Recomposed only when a scoped snapshot loads or the scope changes, both
  // rare; the composed signature moves only when a member's map does, so a
  // recomposition that changes nothing does not rebuild the scene.
  return useMemo((): GraphView => {
    if (!scope) {
      return { snapshot, islands: null, nodeProjectIds: null, regionProjectNames: null, pendingProjectIds: [], worldExtent: 1 };
    }
    const nameOf = (projectId: string): string => projects.find((project) => project.id === projectId)?.name ?? 'Project';
    const loaded = scope.flatMap((projectId) => {
      const entry = scopeSnapshots[projectId];
      return entry ? [{ projectId, snapshot: entry }] : [];
    });
    const pendingProjectIds = scope.filter((projectId) => !scopeSnapshots[projectId]?.projection);
    if (loaded.length === 0) {
      // Nothing read yet (the open project is not in scope): a building map,
      // not "no project open", so the surface and its picker stay up.
      return {
        snapshot: snapshot ? { ...snapshot, projection: null, building: true } : null,
        islands: null,
        nodeProjectIds: null,
        regionProjectNames: null,
        pendingProjectIds,
        worldExtent: 1,
      };
    }

    // The open project first, then the larger maps, so the grid reads from
    // where the user is working outward.
    const ready: IslandSource[] = loaded
      .filter((entry) => entry.snapshot.projection !== null)
      .map((entry) => ({ projectId: entry.projectId, name: nameOf(entry.projectId), projection: entry.snapshot.projection! }))
      .sort((left, right) => {
        if (left.projectId === openProjectId) return -1;
        if (right.projectId === openProjectId) return 1;
        return right.projection.nodes.length - left.projection.nodes.length;
      });
    const snapshots = loaded.map((entry) => entry.snapshot);
    const base = {
      projectId: openProjectId ?? loaded[0].projectId,
      coverage: sumCoverage(snapshots.map((entry) => entry.coverage)),
      // Surface-wide "building" only while there is nothing to draw at all; a
      // project still building beside ready ones is named on its own.
      building: ready.length === 0 && snapshots.some((entry) => entry.building),
      stale: snapshots.some((entry) => entry.stale),
      semanticAvailable: snapshots.every((entry) => entry.semanticAvailable),
    };
    if (ready.length === 0) {
      return {
        snapshot: { ...base, projection: null },
        islands: null,
        nodeProjectIds: null,
        regionProjectNames: null,
        pendingProjectIds,
        worldExtent: 1,
      };
    }
    if (ready.length === 1) {
      const only = ready[0];
      return {
        snapshot: { ...base, projection: only.projection },
        islands: null,
        nodeProjectIds: only.projection.nodes.map(() => only.projectId),
        regionProjectNames: null,
        pendingProjectIds,
        worldExtent: 1,
      };
    }
    const composed = composeIslands(ready);
    return {
      snapshot: { ...base, projection: composed.projection },
      islands: composed.islands,
      nodeProjectIds: composed.nodeProjectIds,
      regionProjectNames: composed.regionProjectNames,
      pendingProjectIds,
      worldExtent: composed.extent,
    };
  }, [snapshot, openProjectId, scope, scopeSnapshots, projects]);
}
