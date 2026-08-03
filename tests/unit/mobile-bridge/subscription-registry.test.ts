import { describe, it, expect, vi } from 'vitest';
import { SubscriptionRegistry } from '../../../src/main/mobile-bridge/session/subscription-registry';

describe('SubscriptionRegistry', () => {
  it('set() then remove() runs the teardown exactly once', () => {
    const registry = new SubscriptionRegistry();
    const teardown = vi.fn();
    registry.set('stream:sess-1', teardown);
    expect(registry.has('stream:sess-1')).toBe(true);

    registry.remove('stream:sess-1');
    expect(teardown).toHaveBeenCalledTimes(1);
    expect(registry.has('stream:sess-1')).toBe(false);
  });

  it('remove() on an unknown key is a no-op', () => {
    const registry = new SubscriptionRegistry();
    expect(() => registry.remove('nope')).not.toThrow();
  });

  it('re-subscribing under the same key tears down the prior subscription instead of leaking it', () => {
    const registry = new SubscriptionRegistry();
    const firstTeardown = vi.fn();
    const secondTeardown = vi.fn();

    registry.set('board:proj-1', firstTeardown);
    registry.set('board:proj-1', secondTeardown);

    expect(firstTeardown).toHaveBeenCalledTimes(1);
    expect(secondTeardown).not.toHaveBeenCalled();
    expect(registry.keys()).toEqual(['board:proj-1']);
  });

  it('dispose() tears down every subscription and is idempotent', () => {
    const registry = new SubscriptionRegistry();
    const teardownA = vi.fn();
    const teardownB = vi.fn();
    registry.set('stream:a', teardownA);
    registry.set('diff:b', teardownB);

    registry.dispose();
    expect(teardownA).toHaveBeenCalledTimes(1);
    expect(teardownB).toHaveBeenCalledTimes(1);
    expect(registry.keys()).toEqual([]);

    // Calling dispose again must not re-run already-torn-down teardowns.
    registry.dispose();
    expect(teardownA).toHaveBeenCalledTimes(1);
    expect(teardownB).toHaveBeenCalledTimes(1);
  });

  /**
   * The change hook the mobile bridge derives its terminal-streamed set from.
   * It must fire on every membership mutation (add, remove, dispose) and read
   * post-change state, but an empty dispose must stay silent - the bridge
   * disposes registries on every device drop, subscribed or not.
   */
  it('onChanged fires after set, remove, and non-empty dispose, reading settled state', () => {
    const observedKeySets: string[][] = [];
    const registry: SubscriptionRegistry = new SubscriptionRegistry(() => {
      observedKeySets.push(registry.keys());
    });

    registry.set('stream:a', () => undefined);
    registry.remove('stream:a');
    registry.dispose(); // empty: no keys were present, so no change to report

    expect(observedKeySets).toEqual([['stream:a'], []]);

    registry.set('stream:b', () => undefined);
    registry.dispose();
    expect(observedKeySets).toEqual([['stream:a'], [], ['stream:b'], []]);
  });
});
