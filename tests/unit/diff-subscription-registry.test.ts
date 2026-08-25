/**
 * Unit tests for DiffSubscriptionRegistry - the per-sender, per-path refcounting
 * behind GIT_DIFF_SUBSCRIBE / GIT_DIFF_UNSUBSCRIBE. Pins the bug it fixes: one
 * subscriber leaving a path must never tear down the other subscribers' watch,
 * and N subscribers must arm exactly one underlying watcher callback (no
 * broadcast amplification).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiffSubscriptionRegistry } from '../../src/main/git/diff-subscription-registry';

const PATH_A = '/mock/worktrees/task-a';
const PATH_B = '/mock/worktrees/task-b';

describe('DiffSubscriptionRegistry', () => {
  let teardownsByPath: Map<string, ReturnType<typeof vi.fn>>;
  let subscribeToPath: ReturnType<typeof vi.fn>;
  let onPathReleased: ReturnType<typeof vi.fn>;
  let registry: DiffSubscriptionRegistry;

  beforeEach(() => {
    teardownsByPath = new Map();
    subscribeToPath = vi.fn((worktreePath: string) => {
      const teardown = vi.fn();
      teardownsByPath.set(worktreePath, teardown);
      return teardown;
    });
    onPathReleased = vi.fn();
    registry = new DiffSubscriptionRegistry(subscribeToPath, onPathReleased);
  });

  it('arms the underlying watch once per path regardless of subscriber count', () => {
    registry.subscribe(1, PATH_A);
    registry.subscribe(2, PATH_A);
    registry.subscribe(3, PATH_A);
    expect(subscribeToPath).toHaveBeenCalledTimes(1);
    expect(subscribeToPath).toHaveBeenCalledWith(PATH_A);

    registry.subscribe(1, PATH_B);
    expect(subscribeToPath).toHaveBeenCalledTimes(2);
    expect(subscribeToPath).toHaveBeenLastCalledWith(PATH_B);
  });

  it('one sender unsubscribing does NOT tear down a path another sender still watches', () => {
    registry.subscribe(1, PATH_A);
    registry.subscribe(2, PATH_A);

    registry.unsubscribe(1, PATH_A);

    expect(teardownsByPath.get(PATH_A)).not.toHaveBeenCalled();
    expect(onPathReleased).not.toHaveBeenCalled();
  });

  it('the last subscriber leaving tears down and releases the path exactly once', () => {
    registry.subscribe(1, PATH_A);
    registry.subscribe(2, PATH_A);

    registry.unsubscribe(1, PATH_A);
    registry.unsubscribe(2, PATH_A);

    expect(teardownsByPath.get(PATH_A)).toHaveBeenCalledTimes(1);
    expect(onPathReleased).toHaveBeenCalledTimes(1);
    expect(onPathReleased).toHaveBeenCalledWith(PATH_A);

    // A straggler unsubscribe after release is a no-op, not a double teardown.
    registry.unsubscribe(2, PATH_A);
    expect(teardownsByPath.get(PATH_A)).toHaveBeenCalledTimes(1);
    expect(onPathReleased).toHaveBeenCalledTimes(1);
  });

  it('calls teardown BEFORE onPathReleased when the last subscriber leaves (ordering is load-bearing - see the class doc)', () => {
    const callOrder: string[] = [];
    const orderedTeardown = vi.fn(() => {
      callOrder.push('teardown');
    });
    const orderedSubscribeToPath = vi.fn(() => orderedTeardown);
    const orderedOnPathReleased = vi.fn(() => {
      callOrder.push('onPathReleased');
    });
    const orderedRegistry = new DiffSubscriptionRegistry(orderedSubscribeToPath, orderedOnPathReleased);

    orderedRegistry.subscribe(1, PATH_A);
    orderedRegistry.subscribe(2, PATH_A);
    orderedRegistry.unsubscribe(1, PATH_A);
    orderedRegistry.unsubscribe(2, PATH_A);

    expect(callOrder).toEqual(['teardown', 'onPathReleased']);
  });

  it('refcounts a same-sender double subscribe (two unsubscribes needed)', () => {
    registry.subscribe(1, PATH_A);
    registry.subscribe(1, PATH_A);

    registry.unsubscribe(1, PATH_A);
    expect(teardownsByPath.get(PATH_A)).not.toHaveBeenCalled();

    registry.unsubscribe(1, PATH_A);
    expect(teardownsByPath.get(PATH_A)).toHaveBeenCalledTimes(1);
    expect(onPathReleased).toHaveBeenCalledWith(PATH_A);
  });

  it('a fresh subscribe after full release re-arms the watch', () => {
    registry.subscribe(1, PATH_A);
    registry.unsubscribe(1, PATH_A);

    registry.subscribe(1, PATH_A);
    expect(subscribeToPath).toHaveBeenCalledTimes(2);
    expect(teardownsByPath.get(PATH_A)).not.toHaveBeenCalled();
  });

  it('releaseSender drops all of a sender refs, releasing only paths left empty', () => {
    registry.subscribe(1, PATH_A);
    registry.subscribe(1, PATH_A);
    registry.subscribe(1, PATH_B);
    registry.subscribe(2, PATH_A);

    registry.releaseSender(1);

    // PATH_B had only sender 1: released. PATH_A still has sender 2: kept.
    expect(teardownsByPath.get(PATH_B)).toHaveBeenCalledTimes(1);
    expect(onPathReleased).toHaveBeenCalledTimes(1);
    expect(onPathReleased).toHaveBeenCalledWith(PATH_B);
    expect(teardownsByPath.get(PATH_A)).not.toHaveBeenCalled();

    registry.unsubscribe(2, PATH_A);
    expect(teardownsByPath.get(PATH_A)).toHaveBeenCalledTimes(1);
    expect(onPathReleased).toHaveBeenCalledWith(PATH_A);
  });

  it('unsubscribe for an unknown path or sender is a no-op', () => {
    registry.unsubscribe(1, PATH_A);

    registry.subscribe(1, PATH_A);
    registry.unsubscribe(2, PATH_A);
    expect(teardownsByPath.get(PATH_A)).not.toHaveBeenCalled();

    registry.releaseSender(99);
    expect(teardownsByPath.get(PATH_A)).not.toHaveBeenCalled();
    expect(onPathReleased).not.toHaveBeenCalled();
  });
});
