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

  /** Registers a subscription's teardown, replacing (and running) any prior teardown under the same key. */
  set(key: string, teardown: () => void): void {
    this.remove(key);
    this.teardowns.set(key, teardown);
  }

  /** Tears down and forgets one subscription. No-op if the key is not present. */
  remove(key: string): void {
    const teardown = this.teardowns.get(key);
    if (!teardown) return;
    this.teardowns.delete(key);
    teardown();
  }

  has(key: string): boolean {
    return this.teardowns.has(key);
  }

  keys(): string[] {
    return Array.from(this.teardowns.keys());
  }

  /** Tears down every subscription. Safe to call repeatedly. */
  dispose(): void {
    for (const teardown of this.teardowns.values()) teardown();
    this.teardowns.clear();
  }
}
