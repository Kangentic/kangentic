/**
 * Unit test for runGitWithTimeout's `env` forwarding (src/main/git/git-spawn.ts).
 *
 * git-spawn.ts is the thin git-flavored wrapper around spawnWithAbort, and it
 * is the one hop in the non-interactive-fetch chain with no dedicated test:
 * fetch-throttle.test.ts pins that fetchAllRemotesIfStale hands `env` to a
 * MOCKED runGitWithTimeout, and spawn-with-abort.test.ts pins that
 * spawnWithAbort hands `env` to the real `child_process.spawn`. Nothing
 * exercises the wrapper itself with both ends real, so a future refactor that
 * destructures `GitSpawnOptions` and forgets to carry `env` through would pass
 * every existing test.
 *
 * `node:child_process` is mocked with a fake child that settles on `close`, so
 * no process is spawned. Mirrors spawn-with-abort.test.ts's fixture.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { runGitWithTimeout } from '../../src/main/git/git-spawn';

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

/** The options object handed to spawn (git args are the binary-spawn shape). */
function spawnOptions(): Record<string, unknown> {
  const call = spawnMock.mock.calls[0];
  return call[call.length - 1] as Record<string, unknown>;
}

describe('runGitWithTimeout env forwarding', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('forwards a supplied env through to the spawned git process', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const env = { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

    const pending = runGitWithTimeout('/mock/repo', ['fetch', '--all'], { timeoutMs: 1_000, env });
    child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({ stdout: '', stderr: '' });
    expect(spawnMock).toHaveBeenCalledWith(
      'git',
      ['fetch', '--all'],
      expect.objectContaining({ cwd: '/mock/repo', env }),
    );
  });

  it('passes no env key at all when none is supplied, so the child inherits process.env', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = runGitWithTimeout('/mock/repo', ['status'], { timeoutMs: 1_000 });
    child.emit('close', 0, null);

    await pending;
    expect(spawnOptions()).not.toHaveProperty('env');
  });
});
