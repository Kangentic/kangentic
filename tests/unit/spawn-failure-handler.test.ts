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
  diagnoseSpawnFailure: () => ({
    errorMessage: 'File not found: ',
    scrollbackSuffix: '',
    errno: '',
    cwdExists: true,
    shellExists: false,
  }),
  recordSpawnFailure: vi.fn(),
}));

import { handleSpawnFailure, type SpawnAttempt, type SpawnFailureContext } from '../../src/main/pty/spawn/spawn-failure-handler';
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
});
