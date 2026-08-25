interface PathSubscriptionEntry {
  /** Teardown for the single underlying watch callback this registry holds for
   *  the path (DiffWatcher.subscribe's return value). */
  teardown: () => void;
  /** Live subscription count per sender (webContents id). A sender that
   *  subscribes twice must unsubscribe twice, mirroring the renderer's
   *  mount/unmount pairing. */
  refsBySender: Map<number, number>;
}

/**
 * Per-sender, per-path refcounting for the GIT_DIFF_SUBSCRIBE / GIT_DIFF_UNSUBSCRIBE
 * IPC pair. The previous handler discarded DiffWatcher's per-callback teardown and
 * answered any single unsubscribe with `watcher.unsubscribe(path)`, which force-closes
 * EVERY callback for that path - so closing one of N windows watching the same
 * worktree (the in-app Changes panel, the detached Changes window, per-file diff
 * windows) silently killed live updates for all the others. (The mobile bridge
 * was never exposed: it deliberately owns a separate DiffWatcher instance.) It also stacked a NEW watcher callback on every subscribe,
 * broadcasting N times per fs event once N panels had mounted on one path.
 *
 * This registry holds exactly ONE watcher callback per path (armed on the first
 * subscriber, torn down when the last leaves) and refcounts subscribers per sender,
 * so a sender's teardown - explicit unsubscribe or its webContents being destroyed -
 * releases only its own refs.
 *
 * Pure bookkeeping with no Electron imports so it is unit-testable; the IPC handler
 * supplies the watcher arm/release effects.
 */
export class DiffSubscriptionRegistry {
  private readonly entries = new Map<string, PathSubscriptionEntry>();

  constructor(
    /** Arm the underlying watch for a path; returns the per-callback teardown
     *  (DiffWatcher.subscribe's return value). Called once per path while it has
     *  any subscriber. */
    private readonly subscribeToPath: (worktreePath: string) => () => void,
    /** Called when a path's LAST subscriber leaves (after teardown), so the
     *  handler can release per-path caches. */
    private readonly onPathReleased: (worktreePath: string) => void,
  ) {}

  subscribe(senderId: number, worktreePath: string): void {
    let entry = this.entries.get(worktreePath);
    if (!entry) {
      entry = { teardown: this.subscribeToPath(worktreePath), refsBySender: new Map() };
      this.entries.set(worktreePath, entry);
    }
    entry.refsBySender.set(senderId, (entry.refsBySender.get(senderId) ?? 0) + 1);
  }

  unsubscribe(senderId: number, worktreePath: string): void {
    const entry = this.entries.get(worktreePath);
    if (!entry) return;
    const senderRefs = entry.refsBySender.get(senderId);
    if (senderRefs === undefined) return;
    if (senderRefs > 1) {
      entry.refsBySender.set(senderId, senderRefs - 1);
      return;
    }
    entry.refsBySender.delete(senderId);
    if (entry.refsBySender.size === 0) this.releasePath(worktreePath, entry);
  }

  /** Release every path this sender still holds (its webContents was destroyed
   *  without unsubscribing - a closed pop-out window, a crashed renderer). */
  releaseSender(senderId: number): void {
    for (const [worktreePath, entry] of [...this.entries]) {
      if (!entry.refsBySender.delete(senderId)) continue;
      if (entry.refsBySender.size === 0) this.releasePath(worktreePath, entry);
    }
  }

  private releasePath(worktreePath: string, entry: PathSubscriptionEntry): void {
    this.entries.delete(worktreePath);
    // Teardown before onPathReleased so cache release observes a fully-closed
    // watch. A teardown whose DiffWatcher entry was already force-closed by
    // relocation's releaseUnder/closeAll is a harmless no-op (removeCallback
    // tolerates a missing entry).
    entry.teardown();
    this.onPathReleased(worktreePath);
  }
}
