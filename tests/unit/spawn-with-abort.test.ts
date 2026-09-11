/**
 * Unit tests for spawnWithAbort's `env` option (src/main/git/spawn-with-abort.ts).
 *
 * The background fetch scheduler must not be able to raise a credential
 * prompt, which it achieves by handing git a copy of the environment with the
 * prompt-suppressing variables set (nonInteractiveGitEnv in fetch-throttle.ts).
 * That only works if the option actually reaches `child_process.spawn`, on
 * BOTH spawn shapes, and if its absence still means "inherit process.env".
 *
 * `node:child_process` is mocked with a fake child that settles on `close`, so
 * no process is spawned.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { spawnWithAbort } from '../../src/main/git/spawn-with-abort';

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

const BINARY_TARGET = {
  command: 'git',
  args: ['fetch', '--all'],
  cwd: '/mock/repo',
  label: 'git fetch --all',
  signalKillAssertsTimeout: true,
};

const SHELL_TARGET = {
  command: 'npm install',
  cwd: '/mock/repo',
  label: 'init script',
  signalKillAssertsTimeout: false,
};

/** The options object handed to spawn, whichever positional shape was used. */
function spawnOptions(): Record<string, unknown> {
  const call = spawnMock.mock.calls[0];
  return call[call.length - 1] as Record<string, unknown>;
}

describe('spawnWithAbort env option', () => {
  beforeEach(() => {
    spawnMock.mockReset();
  });

  it('hands a supplied env to the child on the binary-spawn shape', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const env = { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };

    const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000, env });
    child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({ stdout: '', stderr: '' });
    expect(spawnMock).toHaveBeenCalledWith('git', ['fetch', '--all'], expect.objectContaining({ cwd: '/mock/repo', env }));
  });

  it('hands a supplied env to the child on the shell-string shape', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);
    const env = { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' };

    const pending = spawnWithAbort(SHELL_TARGET, { timeoutMs: 1_000, env });
    child.emit('close', 0, null);

    await expect(pending).resolves.toEqual({ stdout: '', stderr: '' });
    expect(spawnMock).toHaveBeenCalledWith('npm install', expect.objectContaining({ shell: true, env }));
  });

  it('passes no env key at all when none is supplied, so the child inherits process.env', async () => {
    const child = fakeChild();
    spawnMock.mockReturnValue(child);

    const pending = spawnWithAbort(BINARY_TARGET, { timeoutMs: 1_000 });
    child.emit('close', 0, null);

    await pending;
    expect(spawnOptions()).not.toHaveProperty('env');
  });
});
