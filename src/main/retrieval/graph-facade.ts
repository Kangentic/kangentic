/**
 * Main's side of the Knowledge Graph's map. The map service itself
 * (`graph/graph-service.ts`) runs in the retrieval worker: the passes, the
 * region names and the snapshot reads. Main keeps the push to the renderer and
 * the two settings the worker's timers cannot read for themselves (whether
 * region names read task summaries, and how many tasks the summary scheduler
 * passed over), and sends them with each call.
 *
 * Nothing here runs a pass, and nothing waits for one: a refresh returns at
 * once, a first build's steps arrive as the worker's `graph-progress` event,
 * and its end as `graph-changed`.
 */

import { retrievalClient } from './retrieval-client';
import type { KnowledgeGraphBuildProgress, KnowledgeGraphSnapshotWire } from '../../shared/types';

let onChanged: ((projectId: string) => void) | undefined;
let onBuildProgress: ((projectId: string, progress: KnowledgeGraphBuildProgress) => void) | undefined;
let summariesSkipped: (projectId: string) => number = () => 0;
let summaryNamesOn: () => boolean = () => false;
let registeredProjectIds: () => string[] = () => [];
let subscribed = false;

/** Relay the worker's news once there is somewhere to push it. */
function subscribeToWorker(): void {
  if (subscribed) return;
  subscribed = true;
  retrievalClient.on('event', (event, projectId, progress) => {
    if (event === 'graph-changed') onChanged?.(projectId);
    else if (event === 'graph-progress' && progress) onBuildProgress?.(projectId, progress);
  });
  // A worker that died mid-pass took the pass with it, and every open graph
  // still shows it building. Each project is read again, which shows the new
  // worker's state.
  retrievalClient.on('respawned', () => {
    for (const projectId of registeredProjectIds()) onChanged?.(projectId);
  });
}

function warnUnavailable(what: string): (error: unknown) => void {
  return (error) => console.warn(`[knowledge-graph] ${what} not sent to the retrieval worker:`, error instanceof Error ? error.message : error);
}

export const graphService = {
  /** Register the push to the renderer. Last writer wins, which is right
   *  across a dev-mode IPC re-registration. */
  setOnChanged(listener: (projectId: string) => void): void {
    onChanged = listener;
    subscribeToWorker();
  },

  /** Register the push of a first build's progress. Last writer wins. */
  setOnBuildProgress(listener: (projectId: string, progress: KnowledgeGraphBuildProgress) => void): void {
    onBuildProgress = listener;
    subscribeToWorker();
  },

  /** Announce that a project's map changed without a pass (a record sweep,
   *  an embedding drain, a dev seeder). */
  notifyChanged(projectId: string): void {
    onChanged?.(projectId);
  },

  /** Where the Index row reads how many tasks summaries passed over. */
  setSummariesSkipped(provider: (projectId: string) => number): void {
    summariesSkipped = provider;
  },

  /** Whether region names read summaries (task summaries switched on). */
  setSummaryNamesOn(provider: () => boolean): void {
    summaryNamesOn = provider;
  },

  /** The registered projects, read again after the worker restarts. */
  setProjectIds(provider: () => string[]): void {
    registeredProjectIds = provider;
  },

  /** Summaries were written: name the regions again. */
  requestRegionNames(projectId: string, urgent: boolean): void {
    void retrievalClient
      .call('graph.requestRegionNames', { projectId, urgent, summaryNamesOn: summaryNamesOn() })
      .catch(warnUnavailable('a region naming request'));
  },

  /**
   * Ask for a background map pass. Resolves at once with the first build's
   * progress when the project has no map and one runs, or null, the worker
   * not answering included.
   */
  markDirty(projectId: string, modelTag: string, dimensions: number): Promise<KnowledgeGraphBuildProgress | null> {
    return retrievalClient
      .call('graph.refresh', { projectId, modelTag, dimensions, summaryNamesOn: summaryNamesOn() })
      .catch((error: unknown) => {
        warnUnavailable('a map refresh')(error);
        return null;
      });
  },

  /**
   * The snapshot as the renderer receives it. Rejects while the worker cannot
   * answer, and the renderer keeps the map it already shows.
   */
  getSnapshotWire(projectId: string, modelTag: string, knownProjectionKey: string | null): Promise<KnowledgeGraphSnapshotWire> {
    return retrievalClient.call('graph.snapshot', {
      projectId,
      modelTag,
      summaryNamesOn: summaryNamesOn(),
      summariesSkipped: summariesSkipped(projectId),
      knownProjectionKey,
    });
  },
};
