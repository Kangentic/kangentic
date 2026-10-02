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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('node:child_process', () => ({
  exec: vi.fn(),
  execFile: execFileMock,
}));

import { execFileAsync, setOffMainExecutor, type OffMainExecutor } from '../../src/main/utility-process/off-main-exec';
import { launchesOwnBinary, leadingExecutable, ownExecutables, runHostExec, setMainExecutable } from '../../src/main/pty/host/host-exec';
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

  describe('an execFile of a bare name', () => {
    // A bare name has no directory, so the OS finds it on PATH: it can launch
    // the app's own binary as surely as its path does. A path is compared only
    // as a path, so another program that shares the app's name is not refused.
    const appBinary = '/opt/Kangentic/kangentic';
    const execFileOf = (file: string): HostExecRequest => ({ kind: 'execFile', file, args: ['--version'], options: {} });

    it('is refused when its name is the app\'s, whatever its case or a trailing .exe', () => {
      // Red-green: before the bare-name clause an execFile was compared by path
      // only. `path.resolve('kangentic')` is a file in the working directory, not
      // the app's binary, so each of these was allowed through.
      expect(launchesOwnBinary(execFileOf('kangentic'), appBinary)).toBe(true);
      expect(launchesOwnBinary(execFileOf('Kangentic'), appBinary)).toBe(true);
      expect(launchesOwnBinary(execFileOf('kangentic.exe'), appBinary)).toBe(true);
    });

    it('is refused when its name is any one of the executables compared, so main\'s counts as well as the host\'s', () => {
      // On macOS the host's own execPath is the Helper, and main's is the app.
      const helperBinary = '/opt/Kangentic.app/Contents/Frameworks/Kangentic Helper';
      expect(launchesOwnBinary(execFileOf('kangentic'), [helperBinary, appBinary])).toBe(true);
      expect(launchesOwnBinary(execFileOf('kangentic'), [helperBinary])).toBe(false);
    });

    it('is allowed when its name is another program\'s', () => {
      expect(launchesOwnBinary(execFileOf('codex'), appBinary)).toBe(false);
      expect(launchesOwnBinary(execFileOf('git'), appBinary)).toBe(false);
    });

    it('does not reach a path with a directory by its name: a different path with the same name is another program', () => {
      // Guards the clause from widening to every execFile whose basename matches.
      expect(launchesOwnBinary(execFileOf('/usr/bin/kangentic'), appBinary)).toBe(false);
      expect(launchesOwnBinary(execFileOf('/opt/kangentic/bin/kangentic'), appBinary)).toBe(false);
      // The same path is still refused, as a path.
      expect(launchesOwnBinary(execFileOf(appBinary), appBinary)).toBe(true);
    });

    // Compared as Windows paths on every platform, through the platform
    // argument, so CI's Linux runner checks the Windows forms too.
    it('does not reach a Windows path with a directory by its name', () => {
      const windowsBinary = 'C:\\Program Files\\Kangentic\\Kangentic.exe';
      expect(launchesOwnBinary(execFileOf('C:\\Other\\Kangentic.exe'), windowsBinary, 'win32')).toBe(false);
      expect(launchesOwnBinary(execFileOf(windowsBinary), windowsBinary, 'win32')).toBe(true);
      expect(launchesOwnBinary(execFileOf('c:\\program files\\kangentic\\KANGENTIC.EXE'), windowsBinary, 'win32')).toBe(true);
      expect(launchesOwnBinary(execFileOf('Kangentic'), windowsBinary, 'win32')).toBe(true);
    });
  });

  describe('a path that names the app\'s binary another way', () => {
    const execFileOf = (file: string): HostExecRequest => ({ kind: 'execFile', file, args: ['--version'], options: {} });

    // macOS's default file system ignores case, as Windows does, so a path in
    // another case is the same binary there and another file on Linux.
    // Red-green: fold case on Windows only and the darwin assertion fails.
    it('compares a path without case on macOS, and with it on Linux', () => {
      const appBinary = '/Applications/Kangentic.app/Contents/MacOS/Kangentic';
      const otherCase = '/applications/kangentic.app/Contents/MacOS/Kangentic';
      expect(launchesOwnBinary(execFileOf(otherCase), appBinary, 'darwin')).toBe(true);
      expect(launchesOwnBinary(execFileOf(otherCase), appBinary, 'linux')).toBe(false);
    });

    // A link to the app's binary (an install link like `/usr/bin/kangentic`)
    // starts the app as surely as its own path. Symlinks need privileges on
    // Windows, so this runs on POSIX, which CI's runner is.
    // Red-green: drop the real-path compare in `isSameExecutable` and the link
    // is allowed through.
    it.skipIf(process.platform === 'win32')('refuses a link whose target is the app\'s binary, and allows a link to another program', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'own-executable-'));
      try {
        const appBinary = path.join(directory, 'Kangentic');
        const otherBinary = path.join(directory, 'codex');
        fs.writeFileSync(appBinary, '');
        fs.writeFileSync(otherBinary, '');
        const appLink = path.join(directory, 'app-link');
        const otherLink = path.join(directory, 'other-link');
        fs.symlinkSync(appBinary, appLink);
        fs.symlinkSync(otherBinary, otherLink);

        expect(launchesOwnBinary(execFileOf(appLink), appBinary)).toBe(true);
        expect(launchesOwnBinary(execFileOf(otherLink), appBinary)).toBe(false);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
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

    // `quoteArg` (src/shared/paths.ts) writes an apostrophe inside a POSIX path as
    // `'\''`: close the quote, an escaped apostrophe, reopen it. These are plain
    // strings and forward-slash paths, so they run on every platform.
    //
    // Red-green, two lines of `leadingExecutable`. Take the escape out of the
    // regex (`'([^']*)'`, what it was) and the leading word is `/opt/o`, the
    // direct assertions fail, and the app's own binary is allowed through, so
    // the `launchesOwnBinary` assertions fail with them. Keep the regex and drop
    // the `.replace(/'\\''/g, "'")`: the word keeps its `'\''`, the path no
    // longer reads `/opt/o'brien/Kangentic`, and the direct assertions fail. The
    // second binary has the apostrophe in its NAME, which is the case a refusal
    // by name cannot rescue: only the decoded path matches it.
    it('reads the apostrophe `quoteArg` escapes inside a single-quoted leading path, so the app\'s own binary is still refused', () => {
      const directoryBinary = "/opt/o'brien/Kangentic";
      const nameBinary = "/opt/Kangentic/o'brien";

      expect(leadingExecutable("'/opt/o'\\''brien/Kangentic' --version")).toBe(directoryBinary);
      expect(launchesOwnBinary(command("'/opt/o'\\''brien/Kangentic' --version"), directoryBinary)).toBe(true);
      expect(leadingExecutable("'/opt/Kangentic/o'\\''brien' --version")).toBe(nameBinary);
      expect(launchesOwnBinary(command("'/opt/Kangentic/o'\\''brien' --version"), nameBinary)).toBe(true);
      // Another program in the same folder is still allowed.
      expect(launchesOwnBinary(command("'/opt/o'\\''brien/codex' --version"), directoryBinary)).toBe(false);
    });

    // Control for the test above: the escape is read, and nothing wider. Two
    // single-quoted words are the first word and an argument, not one word with
    // a quote in it, so a pattern that runs to the LAST quote (`'(.*)'`) fails
    // here: it reads `/opt/a' 'b`, and a binary named in the second word would
    // read as the first.
    it('stops at the closing quote of the leading word when the next word is quoted too', () => {
      const appBinary = '/opt/Kangentic/kangentic';

      expect(leadingExecutable("'/opt/a' 'b'")).toBe('/opt/a');
      expect(leadingExecutable("'/opt/a' '/opt/Kangentic/kangentic' --version")).toBe('/opt/a');
      expect(launchesOwnBinary(command("'/opt/a' '/opt/Kangentic/kangentic' --version"), appBinary)).toBe(false);
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

    // Compared as Windows paths on every platform, through the platform
    // argument, so CI's Linux runner checks the Windows forms too.
    it('compares a Windows executable name with its .exe stripped', () => {
      const appBinary = 'C:\\Program Files\\Kangentic\\Kangentic.exe';

      expect(launchesOwnBinary(command('"C:\\Program Files\\Kangentic\\Kangentic" --version'), appBinary, 'win32')).toBe(true);
      expect(launchesOwnBinary(command('Kangentic --help'), appBinary, 'win32')).toBe(true);
      expect(launchesOwnBinary(command('"C:\\Program Files\\Kangentic\\bin\\codex" --version'), appBinary, 'win32')).toBe(false);
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
