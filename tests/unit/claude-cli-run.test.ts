/**
 * `runClaudeCli`: the one runner behind Claude's own CLI subcommands
 * (`claude agents --json`, `claude stop <id>`).
 *
 * Contract pinned here:
 *  - An argument that is not a plain word is refused before anything runs, so
 *    no argument can reach the shell the Windows `.cmd` path goes through.
 *  - A CLI that lives in a WSL distro (`resolveCliTarget` answers) runs through
 *    `execCliForTarget`, on any host platform, and never through the local
 *    exec functions.
 *  - On Windows with no target, one command string runs through `execAsync`
 *    with the executable quoted by `quoteCmdExecutable`.
 *  - Elsewhere, `execFileAsync` gets the arguments as an array, never joined.
 *  - A failed run (non-zero exit, timeout) rejects with the exec function's
 *    own error, which the callers rely on.
 *
 * Test tier: Unit. The exec functions and the target resolver are mocked, so
 * nothing is spawned and nothing is written. `process.platform` is stubbed so
 * the file behaves the same on Windows and on Linux CI.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';
import { quoteCmdExecutable } from '../../src/shared/shell-quote';

type ExecOutput = { stdout: string; stderr: string };

const execAsync = vi.fn<(command: string, options?: object) => Promise<ExecOutput>>();
const execFileAsync = vi.fn<(file: string, args?: readonly string[], options?: object) => Promise<ExecOutput>>();
vi.mock('../../src/main/utility-process/off-main-exec', () => ({ execAsync, execFileAsync }));

const resolveCliTarget = vi.fn<(cliPath: string | null | undefined, adapterSupportsWsl: boolean) => Promise<CliTarget | null>>();
const execCliForTarget = vi.fn<(target: CliTarget, cliArgs: readonly string[], options: object) => Promise<ExecOutput>>();
vi.mock('../../src/main/agent/shared/cli-target', () => ({ resolveCliTarget, execCliForTarget }));

const { runClaudeCli } = await import('../../src/main/agent/adapters/claude/cli-run');

const TIMEOUT_MS = 7_500;
/** The runner's output ceiling: it bounds a runaway listing instead of buffering it whole. */
const OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

const WINDOWS_CLI_PATH = 'C:\\Users\\dev\\Program Files\\Claude Code\\claude.cmd';
const POSIX_CLI_PATH = '/home/dev/my tools/claude';
const LISTING_ARGS = ['agents', '--json'];

const WSL_TARGET: CliTarget = {
  kind: 'wsl',
  distro: 'Ubuntu',
  linuxCliPath: '/home/dev/.local/bin/claude',
  facts: {
    distro: 'Ubuntu',
    homeLinux: '/home/dev',
    homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev',
    uncRoot: '\\\\wsl.localhost\\Ubuntu',
    interactivePath: '/usr/local/bin:/usr/bin',
    env: {},
    networkingMode: 'nat',
  },
};

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

function fakePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
}

function expectNothingRan(): void {
  expect(execAsync).not.toHaveBeenCalled();
  expect(execFileAsync).not.toHaveBeenCalled();
  expect(execCliForTarget).not.toHaveBeenCalled();
}

beforeEach(() => {
  execAsync.mockReset();
  execFileAsync.mockReset();
  resolveCliTarget.mockReset();
  execCliForTarget.mockReset();
  // Each runner answers with its own label, so a call routed to the wrong one
  // returns the wrong stdout instead of passing by accident. No target by default.
  resolveCliTarget.mockResolvedValue(null);
  execCliForTarget.mockResolvedValue({ stdout: 'stdout-of-execCliForTarget', stderr: '' });
  execAsync.mockResolvedValue({ stdout: 'stdout-of-execAsync', stderr: '' });
  execFileAsync.mockResolvedValue({ stdout: 'stdout-of-execFileAsync', stderr: '' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
});

describe('runClaudeCli: argument guard', () => {
  describe.each<NodeJS.Platform>(['win32', 'linux'])('on %s', (platform) => {
    beforeEach(() => fakePlatform(platform));

    it.each([
      { label: 'a space and an ampersand', cliArgs: ['a & b'] },
      { label: 'a semicolon', cliArgs: ['x;y'] },
      { label: 'an empty string', cliArgs: [''] },
      { label: 'a pipe', cliArgs: ['a|b'] },
      { label: 'a command substitution', cliArgs: ['$(whoami)'] },
      { label: 'a bad argument after good ones', cliArgs: ['agents', '--json', 'a & b'] },
    ])('refuses $label before resolving a target or running anything', async ({ cliArgs }) => {
      await expect(runClaudeCli(WINDOWS_CLI_PATH, cliArgs, TIMEOUT_MS)).rejects.toThrow('runClaudeCli takes plain arguments only');

      expect(resolveCliTarget).not.toHaveBeenCalled();
      expectNothingRan();
    });

    it('accepts every character class of a plain argument: letters, digits, underscore, dot, colon, equals, hyphen', async () => {
      const cliArgs = ['--flag=value', 'Id_1.2:3-4'];

      await expect(runClaudeCli(POSIX_CLI_PATH, cliArgs, TIMEOUT_MS)).resolves.toEqual(expect.any(String));

      expect(resolveCliTarget).toHaveBeenCalledTimes(1);
    });
  });
});

describe('runClaudeCli: a CLI in a WSL distro', () => {
  describe.each<NodeJS.Platform>(['win32', 'linux'])('on %s', (platform) => {
    beforeEach(() => fakePlatform(platform));

    it('runs through execCliForTarget with the timeout and output limit, returns its stdout, and runs nothing locally', async () => {
      resolveCliTarget.mockResolvedValue(WSL_TARGET);
      execCliForTarget.mockResolvedValue({ stdout: '[{"id":"8c4cb30b"}]', stderr: '' });

      const stdout = await runClaudeCli(WINDOWS_CLI_PATH, LISTING_ARGS, TIMEOUT_MS);

      expect(stdout).toBe('[{"id":"8c4cb30b"}]');
      expect(resolveCliTarget).toHaveBeenCalledWith(WINDOWS_CLI_PATH, true);
      expect(execCliForTarget).toHaveBeenCalledTimes(1);
      expect(execCliForTarget).toHaveBeenCalledWith(WSL_TARGET, LISTING_ARGS, { timeout: TIMEOUT_MS, maxBuffer: OUTPUT_LIMIT_BYTES });
      expect(execAsync).not.toHaveBeenCalled();
      expect(execFileAsync).not.toHaveBeenCalled();
    });
  });
});

describe('runClaudeCli: Windows with no target', () => {
  beforeEach(() => fakePlatform('win32'));

  it('runs one command string through execAsync: the quoted executable, a space, the joined arguments', async () => {
    execAsync.mockResolvedValue({ stdout: '[]', stderr: '' });

    const stdout = await runClaudeCli(WINDOWS_CLI_PATH, ['stop', '8c4cb30b'], TIMEOUT_MS);

    expect(stdout).toBe('[]');
    expect(execAsync).toHaveBeenCalledTimes(1);
    expect(execAsync).toHaveBeenCalledWith(`${quoteCmdExecutable(WINDOWS_CLI_PATH)} stop 8c4cb30b`, {
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: OUTPUT_LIMIT_BYTES,
    });
    expect(execFileAsync).not.toHaveBeenCalled();
    expect(execCliForTarget).not.toHaveBeenCalled();
  });

  it('quotes a cmd-special executable path the way quoteCmdExecutable does, so a space or a percent sign cannot split or expand it', async () => {
    const percentPath = 'C:\\Users\\dev\\%APPDATA%\\Claude Code\\claude.cmd';

    await runClaudeCli(percentPath, LISTING_ARGS, TIMEOUT_MS);

    const [command] = execAsync.mock.calls[0];
    expect(command).toBe(`${quoteCmdExecutable(percentPath)} agents --json`);
    // The raw path is never spliced in: the head is the quoted form, not the path.
    expect(command.startsWith(percentPath)).toBe(false);
  });
});

describe('runClaudeCli: a POSIX host with no target', () => {
  describe.each<NodeJS.Platform>(['linux', 'darwin'])('on %s', (platform) => {
    beforeEach(() => fakePlatform(platform));

    it('runs execFileAsync with the arguments as an array, never joined into a shell string', async () => {
      execFileAsync.mockResolvedValue({ stdout: '[{"id":"6e21471d"}]', stderr: '' });

      const stdout = await runClaudeCli(POSIX_CLI_PATH, ['stop', '8c4cb30b'], TIMEOUT_MS);

      expect(stdout).toBe('[{"id":"6e21471d"}]');
      expect(execFileAsync).toHaveBeenCalledTimes(1);
      expect(execFileAsync).toHaveBeenCalledWith(POSIX_CLI_PATH, ['stop', '8c4cb30b'], {
        timeout: TIMEOUT_MS,
        maxBuffer: OUTPUT_LIMIT_BYTES,
      });
      expect(Array.isArray(execFileAsync.mock.calls[0][1])).toBe(true);
      expect(execAsync).not.toHaveBeenCalled();
      expect(execCliForTarget).not.toHaveBeenCalled();
    });
  });
});

describe('runClaudeCli: a failed run rejects as the exec function does', () => {
  it('propagates the rejection of execCliForTarget', async () => {
    const failure = new Error('wsl.exe exited with code 1');
    resolveCliTarget.mockResolvedValue(WSL_TARGET);
    execCliForTarget.mockRejectedValue(failure);

    await expect(runClaudeCli(WINDOWS_CLI_PATH, LISTING_ARGS, TIMEOUT_MS)).rejects.toBe(failure);
  });

  it('propagates the rejection of execAsync on Windows', async () => {
    const failure = Object.assign(new Error('Command failed: timed out'), { killed: true });
    fakePlatform('win32');
    execAsync.mockRejectedValue(failure);

    await expect(runClaudeCli(WINDOWS_CLI_PATH, LISTING_ARGS, TIMEOUT_MS)).rejects.toBe(failure);
  });

  it('propagates the rejection of execFileAsync on a POSIX host', async () => {
    const failure = Object.assign(new Error('Command failed: exit 2'), { code: 2 });
    fakePlatform('linux');
    execFileAsync.mockRejectedValue(failure);

    await expect(runClaudeCli(POSIX_CLI_PATH, LISTING_ARGS, TIMEOUT_MS)).rejects.toBe(failure);
  });
});
