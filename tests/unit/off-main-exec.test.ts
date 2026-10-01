/**
 * off-main-exec.ts routes one-shot child processes to the pty host, and
 * host-exec.ts runs them there. Pinned: with no executor the call is the
 * plain `promisify` it replaced; with one, the request carries main's current
 * environment and a budget past the child's own timeout; a failed child comes
 * back as the Error `promisify` would have thrown; a host that died with the
 * request in hand rejects instead of running the child twice; and the host
 * refuses to launch its own executable.
 *
 * Tier: Unit.
 */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  execFile: execFileMock,
}));

import { execFileAsync, setOffMainExecutor, type OffMainExecutor } from '../../src/main/utility-process/off-main-exec';
import { launchesOwnBinary, runHostExec } from '../../src/main/pty/host/host-exec';
import type { HostExecRequest } from '../../src/main/pty/host/protocol';

afterEach(() => {
  setOffMainExecutor(null);
  execFileMock.mockReset();
});

describe('off-main-exec', () => {
  it('runs locally, with the caller\'s options untouched, when no executor is registered', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: object, callback: (error: Error | null, output: { stdout: string; stderr: string }) => void) => {
      callback(null, { stdout: 'local', stderr: '' });
    });
    await expect(execFileAsync('git', ['status'], { cwd: '/mock/repo' })).resolves.toEqual({ stdout: 'local', stderr: '' });
    expect(execFileMock).toHaveBeenCalledWith('git', ['status'], { cwd: '/mock/repo' }, expect.any(Function));
  });

  it('sends the request to the executor with main\'s environment and a budget past the child\'s timeout', async () => {
    const executor = vi.fn<OffMainExecutor>(async () => ({ ok: true, stdout: 'from host', stderr: '' }));
    setOffMainExecutor(executor);
    process.env.KANGENTIC_OFF_MAIN_EXEC_PROBE = 'set-after-fork';
    try {
      await expect(execFileAsync('gh', ['auth', 'status'], { timeout: 4000 })).resolves.toEqual({ stdout: 'from host', stderr: '' });
    } finally {
      delete process.env.KANGENTIC_OFF_MAIN_EXEC_PROBE;
    }
    const [request, budgetMs] = executor.mock.calls[0];
    expect(request).toMatchObject({ kind: 'execFile', file: 'gh', args: ['auth', 'status'], options: { timeout: 4000 } });
    expect(request.options.env?.KANGENTIC_OFF_MAIN_EXEC_PROBE).toBe('set-after-fork');
    expect(budgetMs).toBe(9000);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('rejects a failed child with the Error promisify would have thrown', async () => {
    setOffMainExecutor(async () => ({
      ok: false,
      error: { message: 'Command failed: git rev-parse', exitCode: 128, killed: false, signal: null, stdout: '', stderr: 'fatal: not a git repository', cmd: 'git rev-parse' },
    }));
    await expect(execFileAsync('git', ['rev-parse'])).rejects.toMatchObject({
      message: 'Command failed: git rev-parse',
      code: 128,
      stderr: 'fatal: not a git repository',
      killed: false,
    });
  });

  it('rejects, and never runs the child a second time here, when the host died with the request in hand', async () => {
    // The child may already have run in the host: `git branch -D` must not
    // run twice.
    setOffMainExecutor(async () => {
      throw new Error('The pty host exited');
    });
    await expect(execFileAsync('git', ['branch', '-D', 'feature'])).rejects.toThrow('The pty host exited');
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

describe('host-exec', () => {
  const ownExecutable = path.resolve('/mock/Kangentic.exe');

  it('recognizes a request to launch the host\'s own executable, by path or by name', () => {
    const byPath: HostExecRequest = { kind: 'execFile', file: ownExecutable, args: [], options: {} };
    const byCommand: HostExecRequest = { kind: 'exec', command: `"${ownExecutable}" --version`, options: {} };
    const byName: HostExecRequest = { kind: 'exec', command: 'kangentic.exe --squirrel', options: {} };
    const unrelated: HostExecRequest = { kind: 'execFile', file: 'git', args: ['status'], options: {} };
    expect(launchesOwnBinary(byPath, ownExecutable)).toBe(true);
    expect(launchesOwnBinary(byCommand, ownExecutable)).toBe(true);
    expect(launchesOwnBinary(byName, ownExecutable)).toBe(true);
    expect(launchesOwnBinary(unrelated, ownExecutable)).toBe(false);
  });

  it('refuses to launch its own executable without spawning', async () => {
    const result = await runHostExec({ kind: 'execFile', file: process.execPath, args: ['--version'], options: {} });
    expect(result.ok).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('maps a failed child to its exit code, streams and command', async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: object, callback: (error: Error & { code?: number; cmd?: string } | null, stdout: string, stderr: string) => void) => {
      callback(Object.assign(new Error('Command failed: git x'), { code: 1, cmd: 'git x', killed: false }), 'partial', 'boom');
    });
    const result = await runHostExec({ kind: 'execFile', file: 'git', args: ['x'], options: {} });
    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({ message: 'Command failed: git x', exitCode: 1, stdout: 'partial', stderr: 'boom', cmd: 'git x', killed: false }),
    });
  });
});
