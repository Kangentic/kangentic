/**
 * Tracks a single BridgeSession's live event subscriptions (a read-stream
 * tail on a PTY session, a read-board watch on a project, a read-diff watch
 * on a task's worktree), keyed by a caller-chosen subscription id (e.g.
 * `stream:<sessionId>`, `board:<projectId>`, `diff:<taskId>`) so a repeat
 * subscribe to the same key replaces the prior teardown instead of leaking
 * it, and every subscription can be torn down together when the device's
 * transport drops or the bridge shuts the session down.
 */
export class SubscriptionRegistry {
  private readonly teardowns = new Map<string, () => void>();
  private readonly onChanged: (() => void) | undefined;

  /**
   * `onChanged` fires after any key is added or removed (including dispose).
   * The mobile bridge uses it to re-derive which sessions have a live
   * terminal-wanting subscription and tell the renderer, so the bottom panel
   * can suspend those sessions' terminals. The map is mutated before the
   * callback, so a listener always reads the post-change state - but a
   * teardown that removes a sibling key makes the callback fire more than
   * once per operation, so listeners must coalesce.
   */
  constructor(onChanged?: () => void) {
    this.onChanged = onChanged;
  }

  /** Registers a subscription's teardown, replacing (and running) any prior teardown under the same key. */
  set(key: string, teardown: () => void): void {
    this.remove(key);
    this.teardowns.set(key, teardown);
    this.onChanged?.();
  }

  /** Tears down and forgets one subscription. No-op if the key is not present. */
  remove(key: string): void {
    const teardown = this.teardowns.get(key);
    if (!teardown) return;
    this.teardowns.delete(key);
    teardown();
    this.onChanged?.();
  }

  has(key: string): boolean {
    return this.teardowns.has(key);
  }

  keys(): string[] {
    return Array.from(this.teardowns.keys());
  }

  /** Tears down every subscription. Safe to call repeatedly. */
  dispose(): void {
    if (this.teardowns.size === 0) return;
    for (const teardown of this.teardowns.values()) teardown();
    this.teardowns.clear();
    this.onChanged?.();
  }
}
