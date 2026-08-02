/**
 * The renderer half of the "is this grid held" signal. Main parks an unheld
 * PTY back at the spawn grid (SessionManager.scheduleRestingGridRestore), and
 * this registry is what stops it doing that under a terminal that is merely
 * PARKED - unfocused, still mounted, still holding a grid xterm will never
 * re-send. Two behaviours matter: the published set is refcounted (two panes
 * can hold one session), and publishes coalesce (a Backlog -> Board switch
 * mounts N terminals in one commit).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { registerMountedTerminal } from '../../src/renderer/utils/terminal-mount-registry';

let published: string[][];

beforeEach(() => {
  published = [];
  vi.stubGlobal('window', {
    electronAPI: {
      sessions: {
        setMounted: (sessionIds: string[]) => {
          published.push([...sessionIds]);
          return Promise.resolve();
        },
      },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Publishes are coalesced onto a microtask. */
function flush(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(() => resolve()));
}

describe('terminal mount registry', () => {
  it('publishes the mounted set on mount and again on release', async () => {
    const release = registerMountedTerminal('session-a');
    await flush();
    expect(published.at(-1)).toEqual(['session-a']);

    release();
    await flush();
    expect(published.at(-1)).toEqual([]);
  });

  it('keeps a session held until the LAST terminal releases it', async () => {
    const releaseFirst = registerMountedTerminal('session-a');
    const releaseSecond = registerMountedTerminal('session-a');
    await flush();

    releaseFirst();
    await flush();
    expect(published.at(-1)).toEqual(['session-a']);

    releaseSecond();
    await flush();
    expect(published.at(-1)).toEqual([]);
  });

  it('ignores a double release rather than dropping a live claim', async () => {
    const releaseFirst = registerMountedTerminal('session-a');
    registerMountedTerminal('session-a');
    await flush();

    releaseFirst();
    releaseFirst();
    await flush();

    expect(published.at(-1)).toEqual(['session-a']);
  });

  it('coalesces a burst of mounts into one publish', async () => {
    published.length = 0;
    registerMountedTerminal('session-a');
    registerMountedTerminal('session-b');
    registerMountedTerminal('session-c');
    await flush();

    expect(published).toHaveLength(1);
    expect(published[0]?.slice().sort()).toEqual(['session-a', 'session-b', 'session-c']);
  });

  it('holds nothing for a session-less pane', async () => {
    published.length = 0;
    const release = registerMountedTerminal(null);
    release();
    await flush();

    expect(published).toEqual([]);
  });
});
