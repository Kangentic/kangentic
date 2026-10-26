/**
 * Unit tests for `handleSpawnFailure` (src/main/pty/spawn/spawn-failure-handler.ts),
 * the path a session takes when node-pty cannot start its shell (a configured
 * shell not on PATH reports "File not found:").
 *
 * The placeholder row is announced on 'session-changed' BEFORE its 'exit'. Both
 * reach the renderer before the spawn call returns, so with the exit alone the
 * replica met an exit for a row it did not hold: a Command Terminal could not
 * be told apart from a task, and the renderer toasted "Session ended for
 * <raw session id> (exit -1)" beside the start's own error. The same push is
 * what drops the siblings the spawn already drained (session-replica-contract.md).
 *
 * Red-green: removing the 'session-changed' emit fails the order and payload
 * assertions.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/main/pty/spawn/pty-spawn', () => ({
  diagnoseSpawnFailure: vi.fn(() => ({
    kind: 'other',
    errorMessage: 'File not found: ',
    scrollbackSuffix: '',
    errno: '',
    cwdExists: true,
    shellExists: false,
  })),
  recordSpawnFailure: vi.fn(),
}));

import { handleSpawnFailure, type SpawnAttempt, type SpawnFailureContext } from '../../src/main/pty/spawn/spawn-failure-handler';
import { diagnoseSpawnFailure } from '../../src/main/pty/spawn/pty-spawn';
import { SessionRegistry } from '../../src/main/pty/session-registry';
import type { Session } from '../../src/shared/types';

function makeAttempt(overrides: Partial<SpawnAttempt['input']> = {}): SpawnAttempt {
  return {
    id: 'failed-session-id',
    input: {
      taskId: 'terminal-task-id',
      projectId: 'project-1',
      command: 'claude',
      cwd: '/home/dev/project',
      transient: true,
      commandTerminalSlot: 'slot-2',
      ...overrides,
    },
    shell: 'pwsh',
    shellExe: 'pwsh',
    shellArgs: [],
    effectiveCwd: '/home/dev/project',
    previousScrollback: '',
  };
}

function makeContext(): { context: SpawnFailureContext; registry: SessionRegistry; emitted: Array<{ event: string; args: unknown[]; rowRegistered: boolean }> } {
  const registry = new SessionRegistry();
  const emitted: Array<{ event: string; args: unknown[]; rowRegistered: boolean }> = [];
  const context: SpawnFailureContext = {
    registry,
    host: { post: vi.fn() } as unknown as SpawnFailureContext['host'],
    setBufferCols: vi.fn(),
    emit: (event: string, ...args: unknown[]) => {
      emitted.push({ event, args, rowRegistered: registry.get('failed-session-id') !== undefined });
    },
  };
  return { context, registry, emitted };
}

describe('handleSpawnFailure', () => {
  it('announces the exited placeholder on session-changed before its exit, with the row already registered', () => {
    const { context, emitted } = makeContext();

    const session = handleSpawnFailure(new Error('File not found: '), makeAttempt(), context);

    expect(session).toMatchObject({ id: 'failed-session-id', status: 'exited', exitCode: -1 });
    expect(emitted.map((entry) => entry.event)).toEqual(['session-changed', 'exit']);
    const [changed, exit] = emitted;
    // The renderer reads `transient` off this row to skip the crash toast for
    // a Command Terminal; the row must be in the registry when it goes out.
    expect(changed.rowRegistered).toBe(true);
    expect(changed.args[0]).toBe('failed-session-id');
    expect(changed.args[1] as Session).toMatchObject({
      id: 'failed-session-id',
      status: 'exited',
      exitCode: -1,
      transient: true,
      commandTerminalSlot: 'slot-2',
    });
    expect(exit.args).toEqual(['failed-session-id', -1]);
  });

  it('announces a task session the same way, so its exit lands on a row the replica holds', () => {
    const { context, emitted } = makeContext();

    handleSpawnFailure(new Error('File not found: '), makeAttempt({ taskId: 'task-1', transient: false, commandTerminalSlot: undefined }), context);

    expect(emitted.map((entry) => entry.event)).toEqual(['session-changed', 'exit']);
    expect(emitted[0].args[1] as Session).toMatchObject({ taskId: 'task-1', status: 'exited' });
    expect((emitted[0].args[1] as Session).transient).toBeFalsy();
  });

  it('shows a ConPTY whose output never connected its own hint, and logs no posix_spawnp line for it', () => {
    const hint = '\r\nError: The terminal did not start because its output never connected\r\n';
    vi.mocked(diagnoseSpawnFailure).mockReturnValueOnce({
      kind: 'output-not-connected',
      errorMessage: 'Terminal output never connected after 5012 ms, longest pty host stall 4870 ms (ConPTY error code: -1)',
      scrollbackSuffix: hint,
      errno: 'PTY_OUTPUT_NOT_CONNECTED',
      cwdExists: true,
      shellExists: true,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { context } = makeContext();
    try {
      handleSpawnFailure(new Error('Terminal output never connected after 5012 ms, longest pty host stall 4870 ms (ConPTY error code: -1)'), { ...makeAttempt(), previousScrollback: 'carried bytes' }, context);

      expect(context.host.post).toHaveBeenCalledWith({ type: 'initSession', sessionId: 'failed-session-id', scrollback: `carried bytes${hint}`, cols: 120 });
      // The "spawn failed" line itself is still logged; the posix recipe is not.
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('posix_spawnp');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('logs the missing spawn-helper recipe for a posix_spawnp failure, and seeds the ring with the carried scrollback plus its hint', () => {
    const hint = '\r\nError: the terminal helper could not be started, check that spawn-helper is executable\r\n';
    vi.mocked(diagnoseSpawnFailure).mockReturnValueOnce({
      kind: 'posix-spawnp',
      errorMessage: 'posix_spawnp failed.',
      scrollbackSuffix: hint,
      errno: '',
      cwdExists: true,
      shellExists: true,
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { context } = makeContext();
    try {
      handleSpawnFailure(new Error('posix_spawnp failed.'), { ...makeAttempt(), previousScrollback: 'carried bytes' }, context);

      // The shell and cwd in the line are the attempt's, so it names what was tried.
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[PTY] posix_spawnp failed for shell "pwsh" in "/home/dev/project". Likely missing +x on spawn-helper.'));
      // Beside the plain "spawn failed" line every failure logs.
      expect(consoleError).toHaveBeenCalledTimes(2);
      expect(context.host.post).toHaveBeenCalledWith({ type: 'initSession', sessionId: 'failed-session-id', scrollback: `carried bytes${hint}`, cols: 120 });
    } finally {
      consoleError.mockRestore();
    }
  });

  it('seeds the ring with the carried scrollback alone when the diagnosis has no hint to add', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { context } = makeContext();
    try {
      // The default diagnosis is kind 'other' with an empty suffix.
      handleSpawnFailure(new Error('File not found: '), { ...makeAttempt(), previousScrollback: 'carried bytes' }, context);

      expect(context.host.post).toHaveBeenCalledWith({ type: 'initSession', sessionId: 'failed-session-id', scrollback: 'carried bytes', cols: 120 });
      // An 'other' failure logs only the plain line, no posix recipe.
      expect(consoleError).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });
});
