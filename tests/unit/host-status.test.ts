/**
 * The connection state a host row and a project chip show (#913). A link that keeps retrying is promoted
 * to "unreachable" after a while; a link that comes up clears it. Fake timers, no ssh.
 *
 * What a user loses if it breaks: a chip that says "reconnecting" forever for a host that is off, or one
 * that cries "unreachable" for a blip, or a stale state left on a host that was removed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HostStatusBook } from '../../src/main/remote/host-status';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function makeBook(unreachableAfterMs = 20_000) {
  const changes: string[] = [];
  const book = new HostStatusBook({ unreachableAfterMs, onChange: (hostId) => changes.push(hostId), now: () => Date.now() });
  return { book, changes };
}

describe('a host that connects', () => {
  it('reads connected, with no timer left running', () => {
    const { book } = makeBook();

    book.set('h1', 'connecting');
    book.set('h1', 'connected');
    vi.advanceTimersByTime(60_000);

    expect(book.get('h1')?.state).toBe('connected');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('a host that does not come up', () => {
  it('is reconnecting at first, then unreachable once the outage has lasted, keeping the link\'s own words', () => {
    const { book } = makeBook(20_000);

    book.set('h1', 'reconnecting', 'ssh: connect to host lab port 22: Connection timed out');
    vi.advanceTimersByTime(19_000);
    expect(book.get('h1')?.state).toBe('reconnecting');

    vi.advanceTimersByTime(2_000);
    expect(book.get('h1')).toMatchObject({ state: 'unreachable', detail: 'ssh: connect to host lab port 22: Connection timed out' });
  });

  it('does not restart the clock when the link flips between connecting and reconnecting: it is one outage', () => {
    const { book } = makeBook(20_000);

    book.set('h1', 'connecting');
    vi.advanceTimersByTime(10_000);
    book.set('h1', 'reconnecting');
    vi.advanceTimersByTime(11_000);

    expect(book.get('h1')?.state).toBe('unreachable');
  });

  it('is cleared the moment the link connects, and a second outage starts a fresh clock', () => {
    const { book } = makeBook(20_000);
    book.set('h1', 'reconnecting');
    vi.advanceTimersByTime(25_000);
    expect(book.get('h1')?.state).toBe('unreachable');

    book.set('h1', 'connected');
    expect(book.get('h1')?.state).toBe('connected');

    book.set('h1', 'reconnecting');
    vi.advanceTimersByTime(10_000);
    expect(book.get('h1')?.state).toBe('reconnecting');
  });

  it('keeps the explanation a failed setup step gave, which is unreachable at once', () => {
    const { book } = makeBook();

    book.set('h1', 'unreachable', 'Permission denied (publickey).');

    expect(book.get('h1')).toMatchObject({ state: 'unreachable', detail: 'Permission denied (publickey).' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('announcing changes', () => {
  it('tells the listener once per change, and not for the same state and words again', () => {
    const { book, changes } = makeBook();

    book.set('h1', 'connected');
    book.set('h1', 'connected');
    book.set('h1', 'connected', 'now with words');
    book.set('h2', 'connecting');

    expect(changes).toEqual(['h1', 'h1', 'h2']);
  });

  it('stamps the time of the last STATE change, not of a change of words alone', () => {
    const { book } = makeBook();
    vi.setSystemTime(new Date('2026-11-03T10:00:00.000Z'));
    book.set('h1', 'reconnecting', 'first');
    vi.setSystemTime(new Date('2026-11-03T10:00:05.000Z'));
    book.set('h1', 'reconnecting', 'second');

    expect(book.get('h1')?.since).toBe('2026-11-03T10:00:00.000Z');
    expect(book.get('h1')?.detail).toBe('second');
  });
});

describe('a host that is removed', () => {
  it('leaves no state and no pending timer behind', () => {
    const { book } = makeBook();
    book.set('h1', 'reconnecting');

    book.remove('h1');
    vi.advanceTimersByTime(60_000);

    expect(book.get('h1')).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
});
