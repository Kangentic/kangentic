/**
 * `runClaudeCli` with an account's home (task #1057): a slash-command argument is allowed, the
 * `extraEnv` reaches the exec call on both local branches, and a WSL target refuses it. Mocked the
 * same way as claude-cli-run.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { CliTarget } from '../../src/main/agent/shared/cli-target';

type ExecOutput = { stdout: string; stderr: string };

const execAsync = vi.fn<(command: string, options?: object) => Promise<ExecOutput>>();
const execFileAsync = vi.fn<(file: string, args?: readonly string[], options?: object) => Promise<ExecOutput>>();
vi.mock('../../src/main/utility-process/off-main-exec', () => ({ execAsync, execFileAsync }));

const resolveCliTarget = vi.fn<(cliPath: string | null | undefined, adapterSupportsWsl: boolean) => Promise<CliTarget | null>>();
const execCliForTarget = vi.fn<(target: CliTarget, cliArgs: readonly string[], options: object) => Promise<ExecOutput>>();
vi.mock('../../src/main/agent/shared/cli-target', () => ({ resolveCliTarget, execCliForTarget }));

const { runClaudeCli } = await import('../../src/main/agent/adapters/claude/cli-run');

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

const ACCOUNT_ENV = { CLAUDE_CONFIG_DIR: '/accounts/claude/two' };
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

function fakePlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform });
}

beforeEach(() => {
  execAsync.mockReset();
  execFileAsync.mockReset();
  resolveCliTarget.mockReset();
  execCliForTarget.mockReset();
  resolveCliTarget.mockResolvedValue(null);
  execCliForTarget.mockResolvedValue({ stdout: 'wsl', stderr: '' });
  execAsync.mockResolvedValue({ stdout: 'shell', stderr: '' });
  execFileAsync.mockResolvedValue({ stdout: 'file', stderr: '' });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
});

describe('runClaudeCli: slash-command argument', () => {
  it('accepts /usage', async () => {
    fakePlatform('linux');
    await expect(runClaudeCli('/usr/bin/claude', ['-p', '/usage'], 1000)).resolves.toBe('file');
  });

  it.each(['/etc/x', 'a b', '/'])('still refuses %s', async (argument) => {
    fakePlatform('linux');
    await expect(runClaudeCli('/usr/bin/claude', [argument], 1000)).rejects.toThrow('plain arguments only');
    expect(execFileAsync).not.toHaveBeenCalled();
  });
});

describe('runClaudeCli: extraEnv', () => {
  it('reaches execAsync on the Windows shell branch', async () => {
    fakePlatform('win32');
    await runClaudeCli('C:\\tools\\claude.cmd', ['auth', 'status'], 1000, ACCOUNT_ENV);
    const options = execAsync.mock.calls[0][1] as { env?: Record<string, string> };
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(ACCOUNT_ENV.CLAUDE_CONFIG_DIR);
  });

  it('reaches execFileAsync on the POSIX branch', async () => {
    fakePlatform('linux');
    await runClaudeCli('/usr/bin/claude', ['auth', 'status'], 1000, ACCOUNT_ENV);
    const options = execFileAsync.mock.calls[0][2] as { env?: Record<string, string> };
    expect(options.env?.CLAUDE_CONFIG_DIR).toBe(ACCOUNT_ENV.CLAUDE_CONFIG_DIR);
  });

  it.each<NodeJS.Platform>(['win32', 'linux'])('sets no env key without extraEnv on %s', async (platform) => {
    fakePlatform(platform);
    await runClaudeCli('/usr/bin/claude', ['auth', 'status'], 1000);
    const options = (platform === 'win32' ? execAsync.mock.calls[0][1] : execFileAsync.mock.calls[0][2]) as object;
    expect(options).not.toHaveProperty('env');
  });

  it('throws for a WSL target with a non-empty extraEnv, and runs nothing', async () => {
    fakePlatform('win32');
    resolveCliTarget.mockResolvedValue(WSL_TARGET);
    await expect(runClaudeCli('claude', ['auth', 'status'], 1000, ACCOUNT_ENV)).rejects.toThrow('WSL');
    expect(execCliForTarget).not.toHaveBeenCalled();
    expect(execAsync).not.toHaveBeenCalled();
    expect(execFileAsync).not.toHaveBeenCalled();
  });

  it('runs a WSL target with an empty extraEnv', async () => {
    resolveCliTarget.mockResolvedValue(WSL_TARGET);
    await expect(runClaudeCli('claude', ['auth', 'status'], 1000, {})).resolves.toBe('wsl');
  });
});
