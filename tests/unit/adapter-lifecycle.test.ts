/**
 * removeAdapterHooks / releaseCommandHold: a session releases what its adapter
 * wrote for it with its OWN id and the cwd its command was built for.
 *
 * The task id was the key before, and a killed young session's late PTY exit
 * released the hold of the task's next session. And `session.cwd` is where the
 * PTY started, which is the home directory when the requested folder was
 * missing or a UNC path under cmd, so the release missed the folder the
 * adapter wrote into.
 */
import { describe, it, expect, vi } from 'vitest';
import { releaseCommandHold, removeAdapterHooks } from '../../src/main/pty/lifecycle/adapter-lifecycle';
import type { AgentParser } from '../../src/shared/types';

function parserWithRemoveHooks(): { parser: AgentParser; removeHooks: ReturnType<typeof vi.fn> } {
  const removeHooks = vi.fn();
  return { parser: { removeHooks } as unknown as AgentParser, removeHooks };
}

describe('removeAdapterHooks', () => {
  it('releases with the cwd the command was built for and the session id, never the PTY start dir or the task', () => {
    const { parser, removeHooks } = parserWithRemoveHooks();
    removeAdapterHooks({
      id: 'session-1',
      taskId: 'task-1',
      cwd: '/home/dev',
      commandCwd: '/mock/project/.kangentic/worktrees/task-1',
      agentParser: parser,
    });

    expect(removeHooks).toHaveBeenCalledTimes(1);
    expect(removeHooks).toHaveBeenCalledWith('/mock/project/.kangentic/worktrees/task-1', 'session-1');
  });

  it('falls back to cwd when a row carries no commandCwd', () => {
    const { parser, removeHooks } = parserWithRemoveHooks();
    removeAdapterHooks({ id: 'session-1', taskId: 'task-1', cwd: '/mock/project', agentParser: parser });

    expect(removeHooks).toHaveBeenCalledWith('/mock/project', 'session-1');
  });

  it('is a no-op for a session with no adapter', () => {
    expect(() => removeAdapterHooks({ id: 'session-1', taskId: 'task-1', cwd: '/mock/project' })).not.toThrow();
  });

  // The PTY exit handler calls this, and the cleanup after it (detaching the
  // session's files, the fallback PR resolution, the exit event itself) must
  // still run when an adapter's strip fails.
  //
  // Red-green: take the try/catch out of releaseCommandHold and this throws.
  it('does not throw when the adapter\'s removeHooks does, and logs the failure', () => {
    const failure = new Error('EBUSY: settings file locked');
    const { parser, removeHooks } = parserWithRemoveHooks();
    removeHooks.mockImplementation(() => {
      throw failure;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => removeAdapterHooks({
        id: 'abcd1234-5678-90ef',
        taskId: 'task-1',
        cwd: '/mock/project',
        agentParser: parser,
      })).not.toThrow();

      expect(removeHooks).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
      // The log names the session (by its short id) and carries the error.
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('abcd1234'), failure);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('releaseCommandHold', () => {
  it('hands the adapter the folder and the session id', () => {
    const { parser, removeHooks } = parserWithRemoveHooks();
    releaseCommandHold(parser, '/mock/project', 'session-1');
    expect(removeHooks).toHaveBeenCalledWith('/mock/project', 'session-1');
  });

  it('is a no-op with no adapter', () => {
    expect(() => releaseCommandHold(undefined, '/mock/project', 'session-1')).not.toThrow();
  });

  // Most callers sit in a catch or a finally, where a throw here would replace
  // the error being handled (an abort would read as a spawn failure).
  //
  // Red-green: take the try/catch out of releaseCommandHold and this throws.
  it('does not throw when the adapter\'s removeHooks does, and logs the failure', () => {
    const failure = new Error('EACCES: permission denied');
    const { parser, removeHooks } = parserWithRemoveHooks();
    removeHooks.mockImplementation(() => {
      throw failure;
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(() => releaseCommandHold(parser, '/mock/project', 'abcd1234-5678-90ef')).not.toThrow();

      expect(removeHooks).toHaveBeenCalledWith('/mock/project', 'abcd1234-5678-90ef');
      expect(consoleError).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('abcd1234'), failure);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not log when removeHooks succeeds', () => {
    const { parser } = parserWithRemoveHooks();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      releaseCommandHold(parser, '/mock/project', 'session-1');

      expect(consoleError).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });
});
