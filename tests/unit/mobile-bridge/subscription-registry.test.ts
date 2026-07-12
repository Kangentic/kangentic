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
});
