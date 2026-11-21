/**
 * The preload's hold for a push that arrives before the renderer subscribes
 * (src/preload/buffered-push.ts). A Browser pop-out hears a relayed link click
 * as soon as its page loads, before React mounts the pane's subscriber, so
 * without the hold that click opens nothing anywhere.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBufferedPush } from '../../src/preload/buffered-push';

describe('createBufferedPush', () => {
  it('keeps what arrives before a subscriber, in order, for the first one', () => {
    const push = createBufferedPush<[string, string]>();
    push.deliver('task-1', 'https://example.com/first');
    push.deliver('task-1', 'https://example.com/second');

    const callback = vi.fn();
    push.subscribe(callback);
    expect(callback.mock.calls).toEqual([
      ['task-1', 'https://example.com/first'],
      ['task-1', 'https://example.com/second'],
    ]);

    // Taken once: a later subscriber does not replay it.
    const later = vi.fn();
    push.subscribe(later);
    expect(later).not.toHaveBeenCalled();
  });

  it('hands a message straight to every live subscriber, and keeps it again once they leave', () => {
    const push = createBufferedPush<[string]>();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = push.subscribe(first);
    const unsubscribeSecond = push.subscribe(second);
    push.deliver('live');
    expect(first).toHaveBeenCalledExactlyOnceWith('live');
    expect(second).toHaveBeenCalledExactlyOnceWith('live');

    unsubscribeFirst();
    unsubscribeSecond();
    push.deliver('held');
    expect(first).toHaveBeenCalledOnce();

    const next = vi.fn();
    push.subscribe(next);
    expect(next).toHaveBeenCalledExactlyOnceWith('held');
  });
});
