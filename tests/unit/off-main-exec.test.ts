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
import { launchesOwnBinary, ownExecutables, runHostExec, setMainExecutable } from '../../src/main/pty/host/host-exec';
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

  it('does not refuse a command whose path merely contains the app\'s name, only one that starts the app\'s own binary', () => {
    // A build whose binary is `kangentic`, and a probe of another CLI that sits
    // in a folder named for the app. The path contains the app's name; the
    // command does not start the app. Forward slashes are fine on every platform.
    const appBinary = '/opt/Kangentic/kangentic';
    const command = (commandLine: string): HostExecRequest => ({ kind: 'exec', command: commandLine, options: {} });

    expect(launchesOwnBinary(command('"/opt/kangentic/bin/codex" --version'), appBinary)).toBe(false);
    expect(launchesOwnBinary(command('/opt/kangentic/bin/codex --version'), appBinary)).toBe(false);
    expect(launchesOwnBinary({ kind: 'execFile', file: '/opt/kangentic/bin/codex', args: ['--version'], options: {} }, appBinary)).toBe(false);

    // What stays refused: the binary by its path (quoted or not), and by its
    // name from any folder or from the PATH.
    expect(launchesOwnBinary(command('"/opt/Kangentic/kangentic" --version'), appBinary)).toBe(true);
    expect(launchesOwnBinary(command('/opt/Kangentic/kangentic --version'), appBinary)).toBe(true);
    expect(launchesOwnBinary(command('kangentic --help'), appBinary)).toBe(true);
    expect(launchesOwnBinary(command('"/usr/local/bin/Kangentic" --help'), appBinary)).toBe(true);
    expect(launchesOwnBinary({ kind: 'execFile', file: '/opt/Kangentic/kangentic', args: [], options: {} }, appBinary)).toBe(true);
  });

  describe('a POSIX shell command line and a Windows executable name', () => {
    const command = (commandLine: string): HostExecRequest => ({ kind: 'exec', command: commandLine, options: {} });

    it('reads a single-quoted leading path, the form `quoteArg` writes for a POSIX shell', () => {
      const appBinary = '/opt/Kangentic/kangentic';

      // Red-green: before the single-quote branch the leading word was
      // `'/opt/Kangentic/kangentic'` with its quotes, whose name is not the app's,
      // so the app's own binary was allowed through.
      expect(launchesOwnBinary(command("'/opt/Kangentic/kangentic' --version"), appBinary)).toBe(true);
      // Red-green: a space in the folder cut the leading word at `'/opt/Kangentic`,
      // whose name is the app's, so another CLI under that folder was refused.
      expect(launchesOwnBinary(command("'/opt/Kangentic app/bin/codex' --version"), appBinary)).toBe(false);
      // A probe of another CLI in a folder named for the app is still allowed.
      // This one held before the branch too (the quotes made it miss); it guards
      // the branch against matching on the directory.
      expect(launchesOwnBinary(command("'/opt/kangentic/bin/codex' --version"), appBinary)).toBe(false);
    });

    it('compares names with a trailing .exe stripped, so the extensionless name cmd resolves through PATHEXT is refused', () => {
      // Red-green: before the strip, `Kangentic` never matched a candidate named
      // `Kangentic.exe`, so the app's own binary was allowed through by that name.
      const appBinary = '/opt/Kangentic/Kangentic.exe';

      expect(launchesOwnBinary(command('"/opt/Kangentic/Kangentic" --version'), appBinary)).toBe(true);
      expect(launchesOwnBinary(command('Kangentic --help'), appBinary)).toBe(true);
      expect(launchesOwnBinary(command('kangentic.exe --help'), appBinary)).toBe(true);
      expect(launchesOwnBinary(command('"/opt/Kangentic/bin/codex.exe" --version'), appBinary)).toBe(false);
    });

    // Node's path module on POSIX does not split a backslash path, so these
    // Windows-form paths only mean anything on Windows.
    it.runIf(process.platform === 'win32')('compares a Windows executable name with its .exe stripped', () => {
      const appBinary = 'C:\\Program Files\\Kangentic\\Kangentic.exe';

      expect(launchesOwnBinary(command('"C:\\Program Files\\Kangentic\\Kangentic" --version'), appBinary)).toBe(true);
      expect(launchesOwnBinary(command('Kangentic --help'), appBinary)).toBe(true);
      expect(launchesOwnBinary(command('"C:\\Program Files\\Kangentic\\bin\\codex" --version'), appBinary)).toBe(false);
    });
  });

  it('refuses to launch its own executable without spawning', async () => {
    const result = await runHostExec({ kind: 'execFile', file: process.execPath, args: ['--version'], options: {} });
    expect(result.ok).toBe(false);
    expect(execFileMock).not.toHaveBeenCalled();
  });

  describe('main\'s executable, as reported in the host\'s init', () => {
    // On macOS a utility process runs from the app's Helper bundle, so the
    // host's own execPath is never the app binary a request names. Main
    // reports its own in init (`setMainExecutable`).
    const mainBinary = path.resolve('/mock/Kangentic.app/Contents/MacOS/Kangentic');
    afterEach(() => setMainExecutable(undefined));

    it('refuses main\'s executable too, by path and by name, without spawning', async () => {
      setMainExecutable(mainBinary);
      expect(ownExecutables()).toEqual([process.execPath, mainBinary]);
      // Red-green: before main reported its executable, only the host's own
      // execPath was compared, and these were allowed.
      expect(launchesOwnBinary({ kind: 'execFile', file: mainBinary, args: [], options: {} })).toBe(true);
      expect(launchesOwnBinary({ kind: 'exec', command: `"${mainBinary}" --version`, options: {} })).toBe(true);
      const result = await runHostExec({ kind: 'execFile', file: mainBinary, args: ['--version'], options: {} });
      expect(result.ok).toBe(false);
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it('still runs an unrelated command, and with nothing reported compares only its own', () => {
      setMainExecutable(mainBinary);
      expect(launchesOwnBinary({ kind: 'execFile', file: 'git', args: ['status'], options: {} })).toBe(false);
      setMainExecutable(undefined);
      expect(ownExecutables()).toEqual([process.execPath]);
      expect(launchesOwnBinary({ kind: 'execFile', file: mainBinary, args: [], options: {} })).toBe(false);
    });
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
