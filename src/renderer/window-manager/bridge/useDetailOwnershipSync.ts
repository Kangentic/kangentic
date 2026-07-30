/**
 * Reports a host's task-detail ownership to main by DERIVING it from that host's
 * window store, on every change.
 *
 * This is the single reporter for `taskDetailOwnership.syncOwned`, and it replaces
 * the per-host claim/release bookkeeping both hosts used to keep (the board's
 * `claimedRef` map, the monitor's `claimedAnchors` set). Incremental bookkeeping
 * could lose a release and strand a claim in main, which presented as a task
 * answering `focused-existing` for a window that no longer existed anywhere: every
 * attempt to open it focused nothing, silently, and the task stayed unopenable until
 * the renderer reloaded. A full-set report cannot strand anything, because the report
 * IS the state.
 *
 * Two subtleties that are easy to get wrong, both load-bearing:
 *
 * 1. **Mount this where the RENDERER lives, not inside the layer.** A layer that
 *    unmounts while its windows remain (the monitor's layer unmounts on close and on
 *    detach, and its window store deliberately survives) would stop reporting and
 *    stop hearing `DETAIL_CLOSE_HERE` - a phantom that outlives the surface, which is
 *    the bug class this exists to remove. Ownership follows the window STORE, which
 *    outlives the subtree. This is deliberately unlike `useWindowSessionClaims`,
 *    which gates on `isLayerMounted` because an unmounted layer really has no xterm.
 *
 * 2. **Abstain rather than report empty when the set cannot be derived.** An empty
 *    report is a destructive statement ("I host nothing"), so a host that merely does
 *    not know yet must send nothing and let main keep its last-known state, which the
 *    next real report corrects.
 */

import { useEffect, useRef } from 'react';
import type { TaskDetailHost } from '../../../shared/types';
import type { ManagedWindow } from '../store/types';
import type { WindowManager } from '../store/window-store';

/** A minimal store handle, so any Zustand store can be an extra trigger. */
interface Subscribable {
  subscribe: (listener: () => void) => () => void;
}

export interface DetailOwnershipSyncOptions {
  /** The layer whose windows ARE this host's ownership truth. */
  manager: WindowManager;
  /** The surface name main arbitrates on. */
  host: TaskDetailHost;
  /**
   * Decode one task-detail window's anchor into the detail it hosts, or null to
   * exclude it. Same shape as `WindowManagerStoreOptions.anchorToTaskId`, so the
   * monitor passes `parseMonitorAnchor` unchanged while the board resolves its
   * project separately.
   */
  anchorToDetail: (anchor: string) => { projectId: string; taskId: string } | null;
  /**
   * False while this host cannot derive its set at all (no open project yet). The
   * sync is SKIPPED, not sent empty - see the note above.
   */
  ready?: () => boolean;
  /** Stores other than the manager's whose changes can change the derived set. */
  extraTriggers?: Subscribable[];
}

/** The details a host hosts, derived from its windows. Pure, so it is testable. */
export function deriveOwnedDetails(
  windows: ManagedWindow[],
  anchorToDetail: (anchor: string) => { projectId: string; taskId: string } | null,
): Array<{ projectId: string; taskId: string }> {
  const owned: Array<{ projectId: string; taskId: string }> = [];
  const seen = new Set<string>();
  for (const managedWindow of windows) {
    // Only task-detail windows own a detail. A conversation window's anchor is a
    // session id and a command terminal's is a slot.
    if (managedWindow.kind !== 'task-detail') continue;
    const detail = anchorToDetail(managedWindow.anchor);
    if (!detail) continue;
    const key = `${detail.projectId}:${detail.taskId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    owned.push(detail);
  }
  return owned;
}

/** Order-independent identity of a derived set, for change detection. */
function fingerprint(entries: Array<{ projectId: string; taskId: string }>): string {
  return entries.map((entry) => `${entry.projectId}:${entry.taskId}`).sort().join('|');
}

export function useDetailOwnershipSync(options: DetailOwnershipSyncOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  // The last set actually sent. In a ref rather than module scope deliberately: a
  // Fast Refresh remount then re-sends a redundant (idempotent) report instead of
  // suppressing a needed one, which is the safe direction to fail.
  const lastSentRef = useRef<string | null>(null);

  useEffect(() => {
    const report = (): void => {
      const current = optionsRef.current;
      if (current.ready && !current.ready()) return;

      const windows = Object.values(current.manager.store.getState().windows);
      const entries = deriveOwnedDetails(windows, current.anchorToDetail);

      // A window store change is usually geometry (every frame of a drag) or focus,
      // not a change to WHICH details are hosted. Sending unconditionally would push
      // an IPC message plus a main-side fan-out to every renderer many times a
      // second.
      const next = fingerprint(entries);
      if (next === lastSentRef.current) return;
      lastSentRef.current = next;

      window.electronAPI?.taskDetailOwnership?.syncOwned(current.host, entries);
    };

    // An initial report re-asserts the truth after any remount, and is what makes a
    // restored workspace's windows owned at all (nothing else announces them).
    report();

    // Read through the ref, not the dep array: a call site naturally passes a fresh
    // array literal every render, and depending on it would tear down and re-subscribe
    // on every render. The triggers themselves are stable module singletons.
    const { manager, extraTriggers } = optionsRef.current;
    const unsubscribes = [manager.store.subscribe(report)];
    for (const trigger of extraTriggers ?? []) unsubscribes.push(trigger.subscribe(report));
    return () => { for (const unsubscribe of unsubscribes) unsubscribe(); };
  }, []);
}
